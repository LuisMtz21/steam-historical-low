const STEAM_ID = "76561198124362092";
const STEAM_SHOP_ID = 61;
const COUNTRY = "MX";
const STATE_KEY = "wishlist-state-v1";
const HISTORY_KEY = "notification-history-v1";
const SETTINGS_KEY = "monitor-settings-v1";
const LAST_RUN_KEY = "last-run-v1";
const LAST_RESULT_KEY = "last-result-v1";
const BATCH_SIZE = 100;
const MAX_ALERTS_PER_RUN = 10;

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
            historyCount: (await env.KV.get(HISTORY_KEY, "json") || []).filter(item => item.currency === "MXN").length,
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
          const history = (await env.KV.get(HISTORY_KEY, "json") || []).filter(item => item.currency === "MXN");
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
  const lockKey = "run-lock-v1";
  const lockedAt = await env.KV.get(lockKey);
  if (lockedAt && Date.now() - Date.parse(lockedAt) < 15 * 60 * 1000) {
    return { skipped: true, reason: "Ya hay una revisión en curso." };
  }
  await env.KV.put(lockKey, startedAt, { expirationTtl: 900 });
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
  let withoutMexicanPrice = 0;
  let withoutComparableHistoricalLow = 0;
  let withoutAnyHistoricalLow = 0;
  let historicalLowOtherCurrency = 0;
  let mapped = 0;
  let checked = 0;
  let withoutCurrentPrice = 0;
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
    const [overview, steamMexicanPrices] = await Promise.all([
      itadPost(`https://api.isthereanydeal.com/games/overview/v2?${query}`, env, ids),
      getSteamMexicanPrices(batch)
    ]);

    // Overview entrega el mínimo histórico de la tienda seleccionada junto con el precio actual.
    const lowById = new Map((overview?.prices || []).map(row => [row.id, row]));

    for (const game of gameIds) {
      const overviewRow = lowById.get(game.id);
      const steamPrice = steamMexicanPrices.get(String(game.appid));
      const currentPrice = steamPrice?.price;
      const steamLow = overviewRow?.lowest && Number(overviewRow.lowest.shop?.id) === STEAM_SHOP_ID
        ? overviewRow.lowest
        : null;
      const hasCurrentPrice = Boolean(currentPrice && currentPrice.currency === "MXN");
      const hasHistoricalLow = Boolean(steamLow?.price && steamLow.price.currency === "MXN");
      if (!steamLow) withoutAnyHistoricalLow++;
      else if (steamLow.price?.currency !== "MXN") historicalLowOtherCurrency++;
      if (currentPrice && currentPrice.currency !== "MXN") withoutMexicanPrice++;
      if (!hasCurrentPrice) {
        if (!hasHistoricalLow) withoutBothPrices++;
        else withoutCurrentPrice++;
        continue;
      }
      if (!hasHistoricalLow) withoutComparableHistoricalLow++;

      const currentAmount = Number(currentPrice.amount);
      const currency = "MXN";
      if (!Number.isFinite(currentAmount)) continue;
      checked++;
      const regularAmount = steamPrice.regularAmount;
      const discountPercent = steamPrice.discountPercent;
      const key = String(game.appid);
      const old = previousState[key];
      const hasPreviousLow = old && Number.isFinite(Number(old.lowAmount)) && old.lowCurrency === currency;
      const itadLowAmount = hasHistoricalLow ? Number(steamLow.price.amount) : null;
      const comparisonLow = hasHistoricalLow
        ? (hasPreviousLow ? Math.min(itadLowAmount, Number(old.lowAmount)) : itadLowAmount)
        : (hasPreviousLow ? Number(old.lowAmount) : currentAmount);
      if (!Number.isFinite(comparisonLow)) continue;
      const lowAmount = Math.min(comparisonLow, currentAmount);
      const isNewRecord = hasPreviousLow && currentAmount < comparisonLow - 0.000001;
      const isAtLow = currentAmount <= comparisonLow + 0.000001;
      // El mínimo histórico puede coincidir con el precio normal; validar oferta real antes de alertar.
      const isDiscounted = discountPercent > 0 && Number.isFinite(regularAmount) && currentAmount < regularAmount;
      const lowSource = hasHistoricalLow && (!hasPreviousLow || itadLowAmount <= Number(old.lowAmount)) ? "Steam México (IsThereAnyDeal)" : "registro del monitor";
      let title = old?.title || `Steam App ${game.appid}`;

      let type = null;
      if (isDiscounted && isAtLow && isNewRecord) type = hasHistoricalLow ? "NUEVO MÍNIMO HISTÓRICO" : "NUEVO MÍNIMO REGISTRADO";
      else if (isDiscounted && isAtLow && old && !old.wasAtLow) type = hasHistoricalLow ? "IGUALÓ SU MÍNIMO HISTÓRICO" : "IGUALÓ SU MÍNIMO REGISTRADO";
      // En la primera sincronización no existe historial local: avisar de ofertas reales sin fingir que son mínimos históricos.
      else if (isDiscounted && !old) type = "OFERTA ACTIVA (PRIMERA SINCRONIZACIÓN)";

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
          historicalLow: hasHistoricalLow ? itadLowAmount : (hasPreviousLow ? comparisonLow : null),
          historicalLowSource: hasHistoricalLow ? lowSource : (hasPreviousLow ? "registro del monitor" : "no disponible"),
          currency,
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
  notifications.splice(MAX_ALERTS_PER_RUN);

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
      `Sin ninguno de los dos datos: ${withoutBothPrices}`,
      `Sin precio regional MXN de Steam: ${withoutMexicanPrice}`,
      `Sin ningún mínimo histórico de Steam: ${withoutAnyHistoricalLow}`,
      `Mínimo histórico disponible en otra moneda: ${historicalLowOtherCurrency}`,
      `Sin mínimo histórico comparable en MXN: ${withoutComparableHistoricalLow}`,
      `Notificaciones nuevas: ${notifications.length}`,
      `Horarios automáticos: 8:00 a. m. y 12:05 p. m. (Monterrey).`,
      `Los precios se consultan en Steam México; no se realizan conversiones de moneda.`
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
    withoutBothPrices,
    withoutMexicanPrice,
    withoutComparableHistoricalLow,
    alerts: notifications.length,
    manual
  };
  await saveRun(env, result);
  await env.KV.delete(lockKey);
  console.log(JSON.stringify(result));
  return result;
}

async function saveRun(env, result) {
  await env.KV.put(LAST_RUN_KEY, result.finishedAt);
  await env.KV.put(LAST_RESULT_KEY, JSON.stringify(result));
}

async function getSteamMexicanPrices(appids) {
  const prices = new Map();
  for (let offset = 0; offset < appids.length; offset += 100) {
    const batch = appids.slice(offset, offset + 100);
    const url = "https://store.steampowered.com/api/appdetails/?appids=" + batch.join(",") + "&cc=mx&l=spanish&filters=price_overview";
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 Steam Historical Low Notifier" } });
    if (!response.ok) throw new Error("Steam México respondió HTTP " + response.status + " al consultar precios regionales.");
    const data = await response.json();
    for (const appid of batch) {
      const detail = data?.[String(appid)]?.data;
      const overview = detail?.price_overview;
      if (!overview) continue;
      prices.set(String(appid), {
        price: { amount: Number(overview.final) / 100, currency: overview.currency },
        regularAmount: Number(overview.initial) / 100,
        discountPercent: Number(overview.discount_percent) || 0
      });
    }
  }
  return prices;
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
  const photoUrl = item.cover || ("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/" + item.appid + "/header.jpg");
  try {
    // Telegram descarga la imagen; el Worker evita consultar varios CDN por cada juego.
    const response = await fetch(telegramUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, photo: photoUrl, caption: formatAlert(item) })
    });
    const result = await response.json();
    if (response.ok && result.ok) return;
    console.warn("Telegram no pudo enviar la portada; se enviará texto.", result);
  } catch (error) {
    console.warn("Error enviando portada a Telegram.", error);
  }
  await sendTelegram(env, formatAlert(item));
}

async function getSteamAppData(appid, fallback) {
  const defaultCover = "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/" + appid + "/header.jpg";
  try {
    // Una sola consulta a Steam por juego, usando la región México.
    const response = await fetch("https://store.steampowered.com/api/appdetails/?appids=" + appid + "&cc=mx&l=spanish", {
      headers: { "User-Agent": "Mozilla/5.0 Steam Historical Low Notifier" }
    });
    if (response.ok) {
      const data = await response.json();
      const game = data?.[String(appid)]?.data;
      if (game) {
        const price = game.price_overview || {};
        return {
          name: game.name || fallback,
          cover: game.header_image || game.capsule_image || defaultCover,
          coverCandidates: [game.header_image, game.capsule_image, defaultCover].filter(Boolean),
          discountExpiration: price.discount_expiration || game.discount_expiration || null
        };
      }
    }
  } catch (error) {
    console.warn("Steam appdetails no disponible", appid, error);
  }
  return { name: fallback, cover: defaultCover, coverCandidates: [defaultCover], discountExpiration: null };
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


function formatAlert(item) {
  const money = value => new Intl.NumberFormat("es-MX", {
    style: "currency", currency: "MXN", maximumFractionDigits: 2
  }).format(value);
  return [
    `🎮 ${item.type}`,
    item.title,
    `Precio actual: ${money(item.price)} MXN`,
    item.historicalLow === null || !Number.isFinite(Number(item.historicalLow))
      ? "Mínimo histórico: todavía no disponible en MXN"
      : `Mínimo ${item.historicalLowSource === "registro del monitor" ? "registrado por el monitor" : "histórico Steam México"}: ${money(item.historicalLow)} MXN`,
    `Descuento: ${item.discountPercent}%`,
    `Descuento válido hasta: ${formatDiscountExpiration(item.discountExpiration)}`,
    item.url,
    `Historial de precios SteamDB México: https://steamdb.info/app/${item.appid}/?cc=mx`
  ].join("\n");
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
