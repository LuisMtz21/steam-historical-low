const STEAM_ID = "76561198124362092";
const STEAM_SHOP_ID = 61;
const COUNTRY = "MX";
const STATE_KEY = "wishlist-state-v1";
const HISTORY_KEY = "notification-history-v1";
const SETTINGS_KEY = "monitor-settings-v1";
const LAST_RUN_KEY = "last-run-v1";
const LAST_RESULT_KEY = "last-result-v1";
const BATCH_SIZE = 200;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        if (request.method === "GET" && url.pathname === "/api/status") {
          return json({
            ok: true,
            service: "Steam Historical Low Notifier",
            settings: await getSettings(env),
            lastRun: await env.KV.get(LAST_RUN_KEY),
            lastResult: await env.KV.get(LAST_RESULT_KEY, "json"),
            historyCount: (await env.KV.get(HISTORY_KEY, "json") || []).length,
            connections: {
              steam: true,
              itad: Boolean(env.ITAD_API_KEY),
              telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
              storage: Boolean(env.KV)
            }
          });
        }

        if (request.method === "GET" && url.pathname === "/api/settings") {
          return json(await getSettings(env));
        }

        if (request.method === "GET" && url.pathname === "/api/history") {
          const history = await env.KV.get(HISTORY_KEY, "json") || [];
          return json({ history });
        }

        if (request.method === "POST" && url.pathname === "/api/run") {
          requireSecrets(env);
          const result = await runCheck(env, { manual: true });
          return json({ ok: true, result });
        }

        return json({ ok: false, error: "Ruta no encontrada." }, 404);
      } catch (error) {
        console.error(error);
        return json({ ok: false, error: error.message || "Error inesperado." }, 500);
      }
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Steam Historical Low Notifier", { status: 200 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runCheck(env, { manual: false }));
  }
};

async function getSettings(env) {
  return {
    schedule: "8:00 a. m. y 12:05 p. m.",
    timezone: "America/Monterrey",
    times: ["08:00", "12:05"]
  };
}

async function runCheck(env, { manual = false } = {}) {
  requireSecrets(env);
  const startedAt = new Date().toISOString();
  const wishlistUrl = `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${STEAM_ID}`;
  const wishlistResponse = await fetch(wishlistUrl);
  if (!wishlistResponse.ok) {
    throw new Error(`Steam wishlist respondió HTTP ${wishlistResponse.status}`);
  }

  const wishlistJson = await wishlistResponse.json();
  const items = wishlistJson?.response?.items;
  if (!Array.isArray(items)) {
    throw new Error("La respuesta de Steam no contiene response.items. Verifica que la lista de deseados sea pública.");
  }

  const appids = [...new Set(items.map(item => String(item.appid)).filter(id => /^\d+$/.test(id)))];
  if (appids.length === 0) {
    const result = { startedAt, finishedAt: new Date().toISOString(), wishlistGames: 0, gamesMappedToItad: 0, alerts: 0 };
    await saveRun(env, result);
    const message = "La lista de deseados de Steam está vacía. No hay juegos para revisar.";
    await sendTelegram(env, manual ? "🧪 PRUEBA MANUAL COMPLETADA\n" + message : message);
    return result;
  }

  const previousState = await env.KV.get(STATE_KEY, "json") || {};
  const nextState = { ...previousState };
  const notifications = [];
  const usdToMxn = await getUsdToMxnRate();
  let mapped = 0;
  let checked = 0;
  let withoutCurrentPrice = 0;
  let withoutHistoricalLow = 0;
  let withoutBothPrices = 0;

  for (let offset = 0; offset < appids.length; offset += BATCH_SIZE) {
    const batch = appids.slice(offset, offset + BATCH_SIZE);
    const lookup = await itadPost(
      `https://api.isthereanydeal.com/lookup/id/shop/${STEAM_SHOP_ID}/v1`,
      env,
      batch.map(appid => `app/${appid}`)
    );

    const gameIds = Object.entries(lookup || {})
      .filter(([, id]) => typeof id === "string" && id.length > 0)
      .map(([shopGameId, id]) => ({ appid: shopGameId.replace(/^app\//, ""), id }));

    mapped += gameIds.length;
    if (gameIds.length === 0) continue;

    const ids = gameIds.map(game => game.id);
    const query = `country=${COUNTRY}&shops=${STEAM_SHOP_ID}`;
    const [overview, storeLows] = await Promise.all([
      itadPost(`https://api.isthereanydeal.com/games/overview/v2?${query}`, env, ids),
      itadPost(`https://api.isthereanydeal.com/games/storelow/v2?${query}`, env, ids)
    ]);

    const currentById = new Map((overview?.prices || []).map(row => [row.id, row]));
    const lowById = new Map((storeLows || []).map(row => [row.id, row]));

    for (const game of gameIds) {
      const currentRow = currentById.get(game.id);
      const lowRow = lowById.get(game.id);
      const current = currentRow?.current;
      const currentPrice = current?.price;
      const steamLow = lowRow?.lows?.find(low => Number(low.shop?.id ?? low.shop) === STEAM_SHOP_ID);
      const hasCurrentPrice = Boolean(currentPrice);
      const hasHistoricalLow = Boolean(steamLow?.price);
      if (!hasCurrentPrice || !hasHistoricalLow) {
        if (!hasCurrentPrice && !hasHistoricalLow) withoutBothPrices++;
        else if (!hasCurrentPrice) withoutCurrentPrice++;
        else withoutHistoricalLow++;
        continue;
      }

      const currentAmount = Number(currentPrice.amount);
      const lowAmount = Number(steamLow.price.amount);
      const currency = currentPrice.currency || steamLow.price.currency || "MXN";
      if (!Number.isFinite(currentAmount) || !Number.isFinite(lowAmount)) continue;
      if (currentPrice.currency && steamLow.price.currency && currentPrice.currency !== steamLow.price.currency) continue;

      checked++;
      const regularAmount = Number(current?.regular?.amount);
      const discountPercent = Number.isFinite(Number(current?.cut))
        ? Number(current.cut)
        : (regularAmount > currentAmount ? Math.round((1 - currentAmount / regularAmount) * 100) : 0);
      const key = String(game.appid);
      const old = previousState[key];
      const hasPreviousLow = old && Number.isFinite(Number(old.lowAmount)) && old.lowCurrency === currency;
      const isNewRecord = hasPreviousLow && lowAmount < Number(old.lowAmount) - 0.000001;
      const isAtLow = currentAmount <= lowAmount + 0.000001;
      let title = currentRow?.title || old?.title || `Steam App ${game.appid}`;

      let type = null;
      if (isAtLow && isNewRecord) type = "NUEVO MÍNIMO HISTÓRICO";
      else if (isAtLow && old && !old.wasAtLow) type = "IGUALÓ SU MÍNIMO HISTÓRICO";

      if (type) {
        const steamData = await getSteamAppData(game.appid, title);
        title = steamData.name;
        const notification = {
          id: crypto.randomUUID(),
          type,
          title,
          appid: game.appid,
          price: currentAmount,
          regularPrice: Number.isFinite(regularAmount) ? regularAmount : null,
          historicalLow: lowAmount,
          currency,
          usdToMxn,
          discountPercent,
          cover: steamData.cover,
          coverCandidates: steamData.coverCandidates,
          discountExpiration: steamData.discountExpiration,
          sentAt: new Date().toISOString(),
          url: `https://store.steampowered.com/app/${game.appid}/`
        };
        notifications.push(notification);
      }

      nextState[key] = {
        title,
        lowAmount,
        lowCurrency: currency,
        wasAtLow: isAtLow,
        checkedAt: new Date().toISOString()
      };
    }
  }

  const testSent = await env.KV.get("telegram-test-sent");
  if (!testSent) {
    await sendTelegram(env, [
      "✅ CONFIGURACIÓN CONECTADA",
      "Steam e IsThereAnyDeal respondieron correctamente.",
      `Juegos en tu wishlist: ${appids.length}`,
      `Juegos identificados: ${mapped}`,
      "El panel de control ya puede ejecutar revisiones manuales."
    ].join("\n"));
    await env.KV.put("telegram-test-sent", new Date().toISOString());
  }

  notifications.sort((a, b) => b.discountPercent - a.discountPercent);

  for (const notification of notifications) {
    await sendTelegramPhoto(env, notification);
  }

  // Persistimos el estado después de confirmar los envíos para no perder alertas si Telegram falla.
  await env.KV.put(STATE_KEY, JSON.stringify(nextState));

  if (manual) {
    const settings = await getSettings(env);
    await sendTelegram(env, [
      "🧪 PRUEBA MANUAL COMPLETADA",
      `Juegos en wishlist: ${appids.length}`,
      `Juegos identificados en IsThereAnyDeal: ${mapped}`,
      `Juegos con precios comparables revisados: ${checked}`,
      `Sin precio actual: ${withoutCurrentPrice}`,
      `Sin mínimo histórico de Steam: ${withoutHistoricalLow}`,
      `Sin ninguno de los dos datos: ${withoutBothPrices}`,
      `Notificaciones nuevas: ${notifications.length}`,
      `Horarios automáticos: 8:00 a. m. y 12:05 p. m. (Monterrey).`,
      `Tipo de cambio USD/MXN usado para mostrar precios: ${usdToMxn ? usdToMxn.toFixed(4) : "no disponible"}`
    ].join("\n"));
  }

  if (notifications.length) {
    const history = await env.KV.get(HISTORY_KEY, "json") || [];
    await env.KV.put(HISTORY_KEY, JSON.stringify([...notifications, ...history].slice(0, 500)));
  }

  const result = {
    startedAt,
    finishedAt: new Date().toISOString(),
    wishlistGames: appids.length,
    gamesMappedToItad: mapped,
    gamesChecked: checked,
    withoutCurrentPrice,
    withoutHistoricalLow,
    withoutBothPrices,
    alerts: notifications.length,
    manual
  };
  await saveRun(env, result);
  console.log(JSON.stringify(result));
  return result;
}

async function saveRun(env, result) {
  await env.KV.put(LAST_RUN_KEY, result.finishedAt);
  await env.KV.put(LAST_RESULT_KEY, JSON.stringify(result));
}

async function itadPost(url, env, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "ITAD-API-Key": env.ITAD_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`IsThereAnyDeal respondió HTTP ${response.status}: ${detail}`);
  }
  return response.json();
}

async function sendTelegram(env, text) {
  const url = "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true
    })
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error("Telegram no pudo enviar el mensaje: " + JSON.stringify(result).slice(0, 500));
  }
}

async function sendTelegramPhoto(env, item) {
  const telegramUrl = "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendPhoto";
  const candidates = [...new Set([
    ...(item.coverCandidates || []),
    item.cover,
    item.appid === "2069250" ? "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2069250/14a0a45da992ca33d59eb318b5cb9598c070e1c1/header.jpg" : null,
    "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/" + item.appid + "/header.jpg",
    "https://cdn.akamai.steamstatic.com/steam/apps/" + item.appid + "/header.jpg",
    "https://cdn.cloudflare.steamstatic.com/steam/apps/" + item.appid + "/header.jpg"
  ].filter(Boolean))];
  for (const imageUrl of candidates) {
    try {
      const imageResponse = await fetch(imageUrl, { headers: { "User-Agent": "Mozilla/5.0 Steam Historical Low Notifier" } });
      if (!imageResponse.ok) { console.warn("Portada no disponible", imageUrl, imageResponse.status); continue; }
      const imageBlob = await imageResponse.blob();
      if (!imageBlob.type.startsWith("image/") || imageBlob.size < 1000) {
        console.warn("Steam CDN no devolvió una imagen válida", imageUrl, imageBlob.type, imageBlob.size);
        continue;
      }
      const form = new FormData();
      form.append("chat_id", env.TELEGRAM_CHAT_ID);
      form.append("photo", imageBlob, "steam-cover.jpg");
      form.append("caption", formatAlert(item));
      const response = await fetch(telegramUrl, { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok || !result.ok) { console.warn("Telegram rechazó la portada", result); continue; }
      return;
    } catch (error) { console.warn("Error cargando portada", imageUrl, error); }
  }
  console.warn("No se encontró una portada; se enviará el aviso como texto.", item.appid);
  await sendTelegram(env, formatAlert(item));
}

async function getSteamAppData(appid, fallback) {
  const defaultCover = "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/" + appid + "/header.jpg";
  const knownCoverFallbacks = {
    "2069250": "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2069250/14a0a45da992ca33d59eb318b5cb9598c070e1c1/header.jpg"
  };
  for (const country of ["mx", "us"]) {
    try {
      const response = await fetch("https://store.steampowered.com/api/appdetails/?appids=" + appid + "&cc=" + country + "&l=spanish", {
        headers: { "User-Agent": "Mozilla/5.0 Steam Historical Low Notifier" }
      });
      if (!response.ok) continue;
      const data = await response.json();
      const game = data?.[String(appid)]?.data;
      if (!game) continue;
      const price = game.price_overview || {};
      let discountExpiration = price.discount_expiration || game.discount_expiration || null;
      if (!discountExpiration && Number(price.discount_percent || 0) > 0) {
        discountExpiration = await getFeaturedDiscountExpiration(appid);
      }
      const knownCover = knownCoverFallbacks[String(appid)];
      const coverCandidates = [...new Set([
        game.header_image, game.capsule_image, game.capsule_imagev5,
        knownCover, defaultCover
      ].filter(Boolean))];
      return {
        name: game.name || fallback,
        cover: game.header_image || knownCover || defaultCover,
        coverCandidates,
        discountExpiration
      };
    } catch {
      // Try the next Steam region before using a fallback image URL.
    }
  }
  const knownCover = knownCoverFallbacks[String(appid)];
  return {
    name: fallback,
    cover: knownCover || defaultCover,
    coverCandidates: [knownCover, defaultCover].filter(Boolean),
    discountExpiration: null
  };
}

async function getFeaturedDiscountExpiration(appid) {
  try {
    const response = await fetch("https://store.steampowered.com/api/featuredcategories/?cc=mx&l=spanish", {
      headers: { "User-Agent": "Mozilla/5.0 Steam Historical Low Notifier" }
    });
    if (!response.ok) return null;
    const data = await response.json();
    return findDiscountExpiration(data, String(appid), 0);
  } catch {
    return null;
  }
}

function findDiscountExpiration(value, appid, depth) {
  if (!value || typeof value !== "object" || depth > 12) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDiscountExpiration(item, appid, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const itemId = String(value.appid ?? value.id ?? value.app_id ?? "");
  const expiration = value.discount_expiration ?? value.discountExpiration ?? null;
  if (itemId === appid && expiration) return expiration;
  for (const child of Object.values(value)) {
    const found = findDiscountExpiration(child, appid, depth + 1);
    if (found) return found;
  }
  return null;
}

async function getUsdToMxnRate() {
  try {
    const response = await fetch("https://open.er-api.com/v6/latest/USD");
    if (!response.ok) return null;
    const data = await response.json();
    const rate = Number(data?.rates?.MXN);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

function formatAlert(item) {
  const mxn = value => new Intl.NumberFormat("es-MX", {
    style: "currency", currency: "MXN", maximumFractionDigits: 2
  }).format(value * (item.currency === "MXN" ? 1 : item.currency === "USD" && item.usdToMxn ? item.usdToMxn : 1));
  const original = value => new Intl.NumberFormat("es-MX", {
    style: "currency", currency: item.currency, maximumFractionDigits: 2
  }).format(value);
  const converted = item.currency !== "MXN" && item.currency === "USD" && item.usdToMxn;
  return [
    `🎮 ${item.type}`,
    item.title,
    `Precio actual: ${mxn(item.price)}${converted ? " ( " + original(item.price) + " )" : ""}`,
    `Mínimo histórico Steam: ${mxn(item.historicalLow)}${converted ? " ( " + original(item.historicalLow) + " )" : ""}`,
    converted ? `Conversión aproximada con 1 USD = ${item.usdToMxn.toFixed(4)} MXN` : null,
    `Descuento: ${item.discountPercent}%`,
    `Descuento válido hasta: ${formatDiscountExpiration(item.discountExpiration)}`,
    item.url,
    `Historial de precios SteamDB México: https://steamdb.info/app/${item.appid}/?cc=mx`
  ].filter(Boolean).join("\n");
}

function formatDiscountExpiration(value) {
  if (value === null || value === undefined || value === "" || Number(value) === 0) return "Fecha no disponible en Steam";
  let date;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    date = new Date(numeric < 1000000000000 ? numeric * 1000 : numeric);
  } else {
    date = new Date(value);
  }
  if (!Number.isFinite(date.getTime())) return "Fecha no disponible en Steam";
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "medium", timeStyle: "short", timeZone: "America/Monterrey"
  }).format(date) + " (hora Monterrey)";
}

function requireSecrets(env) {
  for (const name of ["ITAD_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
    if (!env[name]) throw new Error(`Falta configurar el secreto ${name} en Cloudflare.`);
  }
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}
