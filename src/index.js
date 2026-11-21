const STEAM_ID = "76561198124362092";
const STEAM_SHOP_ID = 61;
const COUNTRY = "MX";
const STATE_KEY = "wishlist-state-v1";
const BATCH_SIZE = 200;

export default {
  async fetch() {
    return Response.json({
      ok: true,
      service: "Steam Historical Low Notifier",
      schedule: "Cada 6 horas",
      country: COUNTRY,
      store: "Steam"
    });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runCheck(env));
  }
};

async function runCheck(env) {
  requireSecrets(env);

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
    await sendTelegram(env, "La lista de deseados de Steam está vacía. No hay juegos para revisar.");
    return;
  }

  const previousState = await env.KV.get(STATE_KEY, "json") || {};
  const nextState = { ...previousState };
  const notifications = [];
  let mapped = 0;

  for (let offset = 0; offset < appids.length; offset += BATCH_SIZE) {
    const batch = appids.slice(offset, offset + BATCH_SIZE);
    const lookup = await itadPost(
      `https://api.isthereanydeal.com/lookup/id/shop/${STEAM_SHOP_ID}/v1`,
      env,
      batch.map(appid => `app/${appid}`)
    );

    const gameIds = Object.entries(lookup || {})
      .filter(([, id]) => typeof id === "string" && id.length > 0)
      .map(([shopGameId, id]) => ({
        appid: shopGameId.replace(/^app\//, ""),
        id
      }));

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
      const steamLow = lowRow?.lows?.find(low => Number(low.shop?.id) === STEAM_SHOP_ID);

      if (!current?.price || !steamLow?.price) continue;

      const currentAmount = Number(current.price.amount);
      const lowAmount = Number(steamLow.price.amount);
      const currency = current.price.currency || steamLow.price.currency || "MXN";

      if (!Number.isFinite(currentAmount) || !Number.isFinite(lowAmount)) continue;
      if (current.price.currency && steamLow.price.currency && current.price.currency !== steamLow.price.currency) {
        console.warn(`Moneda distinta para app/${game.appid}; se omite para evitar comparación incorrecta.`);
        continue;
      }

      const key = String(game.appid);
      const old = previousState[key];
      const hasPreviousLow = old && Number.isFinite(Number(old.lowAmount)) &&
        old.lowCurrency === currency;
      const isNewRecord = hasPreviousLow && lowAmount < Number(old.lowAmount) - 0.000001;
      const isAtLow = currentAmount <= lowAmount + 0.000001;

      let title = currentRow?.title || old?.title || `Steam App ${game.appid}`;

      if (isAtLow && isNewRecord) {
        notifications.push(formatAlert("NUEVO MÍNIMO HISTÓRICO", title, game.appid, currentAmount, lowAmount, currency));
      } else if (isAtLow && !old?.wasAtLow) {
        notifications.push(formatAlert("IGUALÓ SU MÍNIMO HISTÓRICO", title, game.appid, currentAmount, lowAmount, currency));
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

  // Solo se guarda el estado cuando todas las consultas terminaron correctamente.
  await env.KV.put(STATE_KEY, JSON.stringify(nextState));

  // En la primera ejecución exitosa envía una confirmación única para comprobar Telegram.
  const testSent = await env.KV.get("telegram-test-sent");
  if (!testSent) {
    await sendTelegram(
      env,
      [
        "✅ PRUEBA DE CONFIGURACIÓN COMPLETADA",
        "Steam Historical Low Notifier pudo consultar Steam e IsThereAnyDeal.",
        `Juegos en tu wishlist: ${appids.length}`,
        `Juegos identificados en IsThereAnyDeal: ${mapped}`,
        "El monitor quedó activo. Revisará los precios cada seis horas."
      ].join("\n")
    );
    await env.KV.put("telegram-test-sent", new Date().toISOString());
  }

  if (notifications.length > 0) {
    for (const message of chunkMessages(notifications, 3800)) {
      await sendTelegram(env, message);
    }
  }

  console.log(JSON.stringify({
    wishlistGames: appids.length,
    gamesMappedToItad: mapped,
    alerts: notifications.length
  }));
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
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
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
    throw new Error(`Telegram no pudo enviar el mensaje: ${JSON.stringify(result).slice(0, 500)}`);
  }
}

function formatAlert(type, title, appid, current, low, currency) {
  const format = value => new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency,
    maximumFractionDigits: 2
  }).format(value);

  return [
    `🎮 ${type}`,
    title,
    `Precio actual: ${format(current)}`,
    `Mínimo histórico Steam México: ${format(low)}`,
    `https://store.steampowered.com/app/${appid}/`
  ].join("\n");
}

function chunkMessages(messages, maxLength) {
  const chunks = [];
  let current = "";
  for (const message of messages) {
    const addition = current ? `\n\n──────────\n\n${message}` : message;
    if (current.length + addition.length > maxLength) {
      if (current) chunks.push(current);
      current = message;
    } else {
      current += addition;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function requireSecrets(env) {
  for (const name of ["ITAD_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
    if (!env[name]) throw new Error(`Falta configurar el secreto ${name} en Cloudflare.`);
  }
}
