const STEAM_ID = "76561198124362092";
const WORKER_BASE_URL = "https://steam-historical-low.luismtz21.workers.dev";
const HISTORY_BATCH_SIZE = 50;
const HISTORY_CHECKS_PER_RUN = 10;
const HISTORY_CURSOR_KEY = "steam-index-history-cursor-v1";
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
        if (request.method === "POST" && url.pathname === "/api/internal/steam-index-history") {
          if (!env.STEAM_INDEX_API_KEY || request.headers.get("x-internal-token") !== env.STEAM_INDEX_API_KEY) {
            return json({ ok: false, error: "No autorizado." }, 404);
          }
          const body = await request.json();
          const appids = [...new Set((body.appids || []).map(String).filter(id => /^\d+$/.test(id)))].slice(0, HISTORY_BATCH_SIZE);
          const lows = await getSteamIndexHistoricalLowsDirect(appids, env);
          return json({ ok: true, lows: Object.fromEntries(lows) });
        }

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
              telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
              steamIndex: Boolean(env.STEAM_INDEX_API_KEY),
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
          const body = await request.json().catch(() => ({}));
          const result = await runCheck(env, { manual: true, reportManual: body.reportManual !== false });
          return json({ ok: true, result });
        }

        if (request.method === "POST" && url.pathname === "/api/report") {
          requireSecrets(env);
          const body = await request.json();
          await sendTelegram(env, [
            "🧪 REVISIÓN MANUAL COMPLETADA",
            `Juegos en wishlist: ${Number(body.wishlistGames) || 0}`,
            `Juegos con precios MXN revisados: ${Number(body.gamesChecked) || 0}`,
            `Historiales consultados en Steam Index: ${Number(body.historyRequests) || 0}`,
            `Mínimos históricos MXN obtenidos: ${Number(body.historyMatched) || 0}`,
            `Alertas enviadas: ${Number(body.alerts) || 0}`,
            `Nuevos récords: ${Number(body.newRecords) || 0}`,
            `Mínimos alcanzados: ${Number(body.atLows) || 0}`,
            "Precios comparados exclusivamente en Steam México (MXN)."
          ].join("\n"));
          return json({ ok: true });
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

async function runCheck(env, { manual = false, reportManual = true } = {}) {
  requireSecrets(env);
  const startedAt = new Date().toISOString();
  if (!env.STEAM_INDEX_API_KEY) {
    return {
      skipped: true,
      reason: "Falta configurar STEAM_INDEX_API_KEY para consultar mínimos históricos en MXN."
    };
  }
  const lockKey = "run-lock-v1";
  const lockedAt = await env.KV.get(lockKey);
  if (lockedAt && Date.now() - Date.parse(lockedAt) < 15 * 60 * 1000) {
    return { skipped: true, reason: "Ya hay una revisión en curso." };
  }
  await env.KV.put(lockKey, startedAt, { expirationTtl: 900 });
  try {
  const wishlistUrl = `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${STEAM_ID}`;
  const wishlistResponse = await fetch(wishlistUrl, { signal: AbortSignal.timeout(20000) });
  if (!wishlistResponse.ok) {
    throw new Error(`Steam wishlist respondió HTTP ${wishlistResponse.status}`);
  }

  const wishlistJson = await wishlistResponse.json();
  const items = wishlistJson?.response?.items;
  if (!Array.isArray(items)) {
    throw new Error("La respuesta de Steam no contiene response.items. Verifica que la lista de deseados sea pública.");
  }

  const appids = [...new Set(items.map(item => String(item.appid)).filter(id => /^[0-9]+$/.test(id)))];
  if (appids.length === 0) {
    const result = { startedAt, finishedAt: new Date().toISOString(), wishlistGames: 0, gamesIdentified: 0, alerts: 0 };
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
  let checked = 0;
  let withoutCurrentPrice = 0;
  let withoutBothPrices = 0;
  let steamMexicanPricesCount = 0;
  let steamIndexHistoryRequestsCount = 0;
  let steamIndexHistoryMatchedMxCount = 0;
  let atHistoricalLowCount = 0;
  let newHistoricalLowCount = 0;
  let discountedAboveHistoricalLowCount = 0;

  const steamMexicanPrices = await getSteamMexicanPrices(appids, env);
  steamMexicanPricesCount = steamMexicanPrices.size;

  // Primera sincronización: consultar el mínimo histórico de todos los juegos con precio.
  // Después solo se vuelve a consultar cuando el precio toca o rompe el mínimo guardado.
  const historyCandidates = appids.filter(appid => {
    const steamPrice = steamMexicanPrices.get(String(appid));
    if (!steamPrice) return false;
    const currentAmount = Number(steamPrice.price?.amount);
    const old = previousState[String(appid)];
    const hasOldLow = Boolean(
      old &&
      old.lowAmount !== null &&
      old.lowAmount !== undefined &&
      Number.isFinite(Number(old.lowAmount)) &&
      old.lowCurrency === "MXN"
    );
    const isAtOrBelowOldLow = hasOldLow && currentAmount <= Number(old.lowAmount) + 0.000001;
    const lastHistoryCheck = Date.parse(old?.historyCheckedAt || "");
    const historyCheckDue = !Number.isFinite(lastHistoryCheck) ||
      Date.now() - lastHistoryCheck >= 24 * 60 * 60 * 1000;
    // Consultar historiales nuevos y volver a validar posibles récords como máximo cada 24 horas.
    return historyCheckDue && (!hasOldLow || isAtOrBelowOldLow);
  });

  // Cloudflare Free permite 50 subrequests externos por ejecución.
  // Procesamos 10 historiales por revisión y rotamos el cursor para completar
  // la wishlist en varias ejecuciones sin superar ese límite.
  const historyCursor = await env.KV.get(HISTORY_CURSOR_KEY);
  const cursorIndex = appids.indexOf(String(historyCursor));
  const historyCandidateSet = new Set(historyCandidates);
  const historyBatchCandidates = [];
  for (let step = 1; step <= appids.length && historyBatchCandidates.length < HISTORY_CHECKS_PER_RUN; step++) {
    const candidate = appids[(cursorIndex + step + appids.length) % appids.length];
    if (historyCandidateSet.has(candidate)) historyBatchCandidates.push(candidate);
  }

  const steamIndexLows = await getSteamIndexHistoricalLows(
    historyBatchCandidates.map(appid => ({ appid })),
    env
  );
  steamIndexHistoryRequestsCount = historyBatchCandidates.length;
  steamIndexHistoryMatchedMxCount = [...steamIndexLows.values()].filter(Boolean).length;

  for (const appid of appids) {
    const key = String(appid);
    const steamPrice = steamMexicanPrices.get(key);
    const currentPrice = steamPrice?.price || null;
    const regularPrice = steamPrice
      ? { amount: steamPrice.regularAmount, currency: steamPrice.price.currency }
      : null;
    const discountPercent = Number(steamPrice?.discountPercent) || 0;
    const steamIndexLow = steamIndexLows.get(key) || null;
    const hasCurrentPrice = Boolean(currentPrice && currentPrice.currency === "MXN");
    const hasHistoricalLow = Boolean(
      steamIndexLow &&
      steamIndexLow.currency === "MXN" &&
      Number.isFinite(Number(steamIndexLow.amount))
    );
    const old = previousState[key];
    const hasPreviousLow = Boolean(
      old &&
      old.lowAmount !== null &&
      old.lowAmount !== undefined &&
      Number.isFinite(Number(old.lowAmount)) &&
      old.lowCurrency === "MXN"
    );
    const hasHistoricalReference = hasHistoricalLow || hasPreviousLow;
    if (!hasHistoricalReference) {
      withoutComparableHistoricalLow++;
      withoutAnyHistoricalLow++;
    }

    if (!hasCurrentPrice) {
      if (currentPrice && currentPrice.currency !== "MXN") withoutMexicanPrice++;
      if (!hasHistoricalReference) withoutBothPrices++;
      else withoutCurrentPrice++;
      continue;
    }

    const currentAmount = Number(currentPrice.amount);
    if (!Number.isFinite(currentAmount)) continue;
    checked++;

    const regularAmount = Number(regularPrice?.amount);
    const previousLowAmount = hasPreviousLow ? Number(old.lowAmount) : null;
    const steamIndexLowAmount = hasHistoricalLow ? Number(steamIndexLow.amount) : null;
    const knownLows = [previousLowAmount, steamIndexLowAmount].filter(value => Number.isFinite(value) && value >= 0);
    const comparisonLow = knownLows.length ? Math.min(...knownLows) : null;
    const hasReference = comparisonLow !== null;
    const isDiscounted = discountPercent > 0 && Number.isFinite(regularAmount) && currentAmount < regularAmount;
    const epsilon = 0.000001;

    const isNewRecord = hasReference && (
      currentAmount < comparisonLow - epsilon ||
      (hasPreviousLow && hasHistoricalLow &&
        steamIndexLowAmount < previousLowAmount - epsilon &&
        currentAmount <= steamIndexLowAmount + epsilon)
    );
    const isAtLow = hasReference && currentAmount <= comparisonLow + epsilon;
    if (isNewRecord) newHistoricalLowCount++;
    else if (isAtLow && !old?.wasAtLow) atHistoricalLowCount++;
    else if (isDiscounted && hasReference && !isAtLow) discountedAboveHistoricalLowCount++;

    const nextLowAmount = isNewRecord
      ? currentAmount
      : (hasReference ? comparisonLow : null);
    const lowSource = steamIndexLow
      ? "Steam Index · Steam México (desde septiembre de 2026)"
      : "mínimo histórico guardado por el monitor";
    const title = old?.title || steamPrice?.title || "Steam App " + appid;

    // Solo notificamos mínimos cuando existe una oferta real.
    // Guardamos por separado si ya se notificó un mínimo con descuento:
    // un precio sin descuento no debe bloquear una alerta posterior.
    const wasAtDiscountedLow = Boolean(old?.wasAtDiscountedLow);
    let type = null;
    if (isDiscounted && isNewRecord) type = "NUEVO MÍNIMO REGISTRADO";
    else if (isDiscounted && isAtLow && !wasAtDiscountedLow) type = "MÍNIMO HISTÓRICO REGISTRADO";

    if (type) {
      const defaultCover = "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/" + appid + "/header.jpg";
      notifications.push({
        id: crypto.randomUUID(),
        type,
        title,
        appid,
        price: currentAmount,
        regularPrice: Number.isFinite(regularAmount) ? regularAmount : null,
        historicalLow: isNewRecord ? currentAmount : comparisonLow,
        previousHistoricalLow: isNewRecord
          ? (hasHistoricalLow && currentAmount < steamIndexLowAmount - epsilon
            ? steamIndexLowAmount
            : (hasPreviousLow ? previousLowAmount : steamIndexLowAmount))
          : null,
        historicalLowSource: lowSource,
        currency: "MXN",
        discountPercent,
        cover: defaultCover,
        coverCandidates: [defaultCover],
        discountExpiration: null,
        sentAt: new Date().toISOString(),
        url: "https://store.steampowered.com/app/" + appid + "/"
      });
    }

    nextState[key] = {
      title,
      lowAmount: nextLowAmount,
      lowCurrency: "MXN",
      wasAtLow: isAtLow,
      wasAtDiscountedLow: isDiscounted && (isAtLow || isNewRecord),
      // Marcar también los intentos sin historial disponible para que no se repitan
      // indefinidamente y la revisión completa pueda avanzar al siguiente lote.
      historyCheckedAt: historyBatchCandidates.includes(key)
        ? new Date().toISOString()
        : (old?.historyCheckedAt || null),
      checkedAt: new Date().toISOString()
    };
  }

  const testSent = await env.KV.get("telegram-test-sent");
  if (!testSent) {
    await sendTelegram(env, [
      "✅ CONFIGURACIÓN CONECTADA",
      "Steam y Steam Index respondieron correctamente.",
      `Juegos en tu wishlist: ${appids.length}`,
      `Juegos identificados: ${appids.length}`,
      "El panel de control ya puede ejecutar revisiones manuales."
    ].join("\n"));
    await env.KV.put("telegram-test-sent", new Date().toISOString());
  }

  const alertsFoundBeforeLimit = notifications.length;
  notifications.sort((a, b) =>
    Number(b.type === "NUEVO MÍNIMO HISTÓRICO") - Number(a.type === "NUEVO MÍNIMO HISTÓRICO") ||
    (b.discountPercent - a.discountPercent)
  );
  notifications.splice(MAX_ALERTS_PER_RUN);

  // Consultar detalles e imágenes solo para las 10 alertas que realmente se enviarán.
  // Antes se consultaba Steam para cada oferta encontrada, incluso las descartadas por el límite.
  for (let i = 0; i < notifications.length; i += 5) {
    const batch = notifications.slice(i, i + 5);
    const steamData = await Promise.all(batch.map(item => getSteamAppData(item.appid, item.title)));
    batch.forEach((item, index) => {
      item.title = steamData[index].name;
      item.cover = steamData[index].cover;
      item.coverCandidates = steamData[index].coverCandidates;
      item.discountExpiration = steamData[index].discountExpiration;
    });
  }

  for (const notification of notifications) {
    await sendTelegramPhoto(env, notification);
  }

  // Persistimos el estado después de confirmar los envíos para no perder alertas si Telegram falla.
  await env.KV.put(STATE_KEY, JSON.stringify(nextState));
  if (historyBatchCandidates.length) {
    await env.KV.put(HISTORY_CURSOR_KEY, historyBatchCandidates[historyBatchCandidates.length - 1]);
  }

  if (manual && reportManual) {
    const settings = await getSettings(env);
    await sendTelegram(env, [
      "🧪 PRUEBA MANUAL COMPLETADA",
      `Juegos en wishlist: ${appids.length}`,
      `Juegos identificados en Steam: ${appids.length}`,
      `Juegos con precios comparables revisados: ${checked}`,
      `Sin precio actual: ${withoutCurrentPrice}`,
      `Sin ninguno de los dos datos: ${withoutBothPrices}`,
      `Sin precio regional MXN de Steam: ${withoutMexicanPrice}`,
      `Sin ningún mínimo histórico de Steam: ${withoutAnyHistoricalLow}`,
      `Sin mínimo histórico comparable en MXN: ${withoutComparableHistoricalLow}`,
      `Steam Index API: ${env.STEAM_INDEX_API_KEY ? "configurado" : "NO CONFIGURADO"}`,
      `Historiales MXN consultados en Steam Index: ${steamIndexHistoryRequestsCount}`,
      `Mínimos históricos MXN obtenidos: ${steamIndexHistoryMatchedMxCount}`,
      `Juegos que igualaron su mínimo histórico: ${atHistoricalLowCount}`,
      `Juegos que rompieron su mínimo histórico: ${newHistoricalLowCount}`,
      `Ofertas por encima del mínimo ignoradas: ${discountedAboveHistoricalLowCount}`,
      `Precios MXN obtenidos de Steam: ${steamMexicanPricesCount}`,
      `Alertas de mínimos detectadas antes del límite: ${alertsFoundBeforeLimit}`,
      `Notificaciones enviadas: ${notifications.length}`,
      `Horarios automáticos: 8:00 a. m. y 12:05 p. m. (Monterrey).`,
      `Los precios y mínimos se comparan exclusivamente en MXN y en Steam México.`
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
    gamesIdentified: appids.length,
    gamesChecked: checked,
    withoutCurrentPrice,
    withoutBothPrices,
    withoutMexicanPrice,
    withoutComparableHistoricalLow,
    alerts: notifications.length,
    atHistoricalLow: atHistoricalLowCount,
    newHistoricalLow: newHistoricalLowCount,
    discountedAboveHistoricalLowIgnored: discountedAboveHistoricalLowCount,
    diagnostics: {
      steamMexicanPrices: steamMexicanPricesCount,
      steamIndexConfigured: Boolean(env.STEAM_INDEX_API_KEY),
      steamIndexHistoryRequests: steamIndexHistoryRequestsCount,
      steamIndexHistoryMatchedMx: steamIndexHistoryMatchedMxCount,
      steamIndexHistoryCandidates: historyCandidates.length,
      steamIndexHistoryPending: Math.max(0, historyCandidates.length - historyBatchCandidates.length),
      withoutAnyHistoricalLow,
      alertsFoundBeforeLimit,
    },
    manual
  };
  await saveRun(env, result);
  await env.KV.delete("last-error-v1");
  console.log(JSON.stringify(result));
  return result;
  } catch (error) {
    await env.KV.put("last-error-v1", JSON.stringify({
      at: new Date().toISOString(),
      message: error?.message || String(error)
    }));
    console.error("Falló la revisión de wishlist:", error);
    throw error;
  } finally {
    await env.KV.delete(lockKey);
  }
}

async function saveRun(env, result) {
  await env.KV.put(LAST_RUN_KEY, result.finishedAt);
  await env.KV.put(LAST_RESULT_KEY, JSON.stringify(result));
}

async function getSteamIndexHistoricalLows(games, env) {
  const lows = new Map();
  for (let offset = 0; offset < games.length; offset += HISTORY_BATCH_SIZE) {
    if (offset > 0) await new Promise(resolve => setTimeout(resolve, 61000));
    const batch = games.slice(offset, offset + HISTORY_BATCH_SIZE);
    // Consulta Steam Index directamente desde esta ejecución. Evita una
    // petición HTTP del Worker hacia su propio dominio, que puede terminar en 522.
    const batchLows = await getSteamIndexHistoricalLowsDirect(
      batch.map(game => String(game.appid)),
      env
    );
    for (const [appid, low] of batchLows) lows.set(appid, low);
  }
  return lows;
}

async function getSteamIndexHistoricalLowsDirect(appids, env) {
  const lows = new Map();
  const concurrency = 10;
  for (let offset = 0; offset < appids.length; offset += concurrency) {
    const batch = appids.slice(offset, offset + concurrency);
    const results = await Promise.all(batch.map(async appid => [
      String(appid),
      await getSteamIndexHistoricalLow(appid, env)
    ]));
    for (const [appid, low] of results) lows.set(appid, low);
  }
  return lows;
}

async function getSteamIndexHistoricalLow(appid, env) {
  const url = `https://public-api.steamidx.com/v1/apps/${appid}/prices/history?currency=MXN`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      headers: {
        "Authorization": "Bearer " + env.STEAM_INDEX_API_KEY,
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(20000)
    });

    if (response.status === 404) return null;
    if (response.status === 429) {
      const retryAfter = Number(response.headers?.get("Retry-After")) || 60;
      if (retryAfter > 90 || attempt === 2) {
        throw new Error("Steam Index alcanzó su límite de solicitudes. Reintenta en " + retryAfter + " segundos.");
      }
      await new Promise(resolve => setTimeout(resolve, Math.max(1, retryAfter) * 1000));
      continue;
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Steam Index respondió HTTP ${response.status}: ${detail}`);
    }

    const result = await response.json();
    const currency = result?.data?.currency || result?.meta?.currency;
    const lowest = result?.data?.lowest;
    if (
      currency !== "MXN" ||
      lowest?.finalPrice === null ||
      lowest?.finalPrice === undefined ||
      !Number.isFinite(Number(lowest.finalPrice))
    ) return null;

    return {
      amount: Number(lowest.finalPrice) / 100,
      currency: "MXN",
      at: lowest.at || null
    };
  }
  return null;
}

async function getSteamMexicanPrices(appids, env) {
  const prices = new Map();
  for (let offset = 0; offset < appids.length; offset += 100) {
    const batch = appids.slice(offset, offset + 100);
    const url = "https://public-api.steamidx.com/v1/apps?ids=" + batch.join(",") + "&currency=MXN";
    const response = await fetch(url, {
      headers: {
        "Authorization": "Bearer " + env.STEAM_INDEX_API_KEY,
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error("Steam Index respondió HTTP " + response.status + " al consultar precios MXN: " + detail);
    }

    const result = await response.json();
    for (const app of result?.data || []) {
      const appid = String(app.appId);
      const price = app.price;
      if (
        !/^\d+$/.test(appid) ||
        !price ||
        price.currency !== "MXN" ||
        !Number.isFinite(Number(price.finalPrice)) ||
        !Number.isFinite(Number(price.initialPrice))
      ) continue;

      prices.set(appid, {
        price: { amount: Number(price.finalPrice) / 100, currency: "MXN" },
        regularAmount: Number(price.initialPrice) / 100,
        discountPercent: Number(price.discountPercent) || 0,
        discountExpiration: price.discountEndsAt || null,
        title: app.name || null
      });
    }
  }
  return prices;
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
    }),
    signal: AbortSignal.timeout(15000)
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
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, photo: photoUrl, caption: formatAlert(item) }),
      signal: AbortSignal.timeout(15000)
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
      headers: { "User-Agent": "Mozilla/5.0 Steam Historical Low Notifier" },
      signal: AbortSignal.timeout(15000)
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
  const lowLines = item.type === "NUEVO MÍNIMO HISTÓRICO"
    ? [
        `Mínimo histórico anterior: ${money(item.previousHistoricalLow)} MXN`,
        `Nuevo mínimo histórico: ${money(item.historicalLow)} MXN`
      ]
    : [`Mínimo histórico Steam México: ${money(item.historicalLow)} MXN`];
  return [
    `🎮 ${item.type}`,
    item.title,
    `Precio actual: ${money(item.price)} MXN`,
    ...lowLines,
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
  for (const name of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
    if (!env[name]) throw new Error(`Falta configurar el secreto ${name} en Cloudflare.`);
  }
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}
