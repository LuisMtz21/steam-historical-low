# Steam Historical Low Notifier

Monitor de la lista pública de deseados de Steam México. Envía alertas por Telegram únicamente cuando el precio actual de un juego iguala o rompe su mínimo histórico de Steam México.

## Panel

El panel del Worker permite:

- Consultar la última revisión y el estado de las conexiones.
- Ejecutar una revisión manual.
- Consultar el historial de alertas de mínimos históricos.
- Ver el precio actual, mínimo histórico, descuento y fecha de notificación.

## Tipos de alerta

- **MÍNIMO HISTÓRICO:** el precio actual iguala el menor precio histórico conocido para Steam México.
- **NUEVO MÍNIMO HISTÓRICO:** el precio actual queda por debajo del mínimo anterior registrado, o Steam ya está vendiendo al nuevo mínimo menor que el monitor tenía guardado.

No se envían alertas por descuentos que sigan por encima del mínimo histórico. El porcentaje de descuento no determina si se genera una alerta: lo determinante es el precio frente al mínimo histórico.

Las alertas se comparan exclusivamente en MXN, para Steam (shop ID 61), país MX. Si no existe un mínimo histórico verificable en MXN, el juego no genera una alerta hasta disponer de esa referencia.

## Fuentes de precios

El monitor combina:

- Steam AppDetails con región México (cc=mx) para el precio actual y precio normal.
- IsThereAnyDeal /games/storelow/v2 con country=MX&shops=61 para consultar el mínimo histórico por tienda.
- IsThereAnyDeal /games/overview/v2 como fuente alternativa del mínimo histórico.
- IsThereAnyDeal /games/prices/v3 con deals=true como fuente alternativa de ofertas.

No se convierten precios de otras monedas a MXN.

## Cómo evita las alertas repetidas

El Worker guarda por juego el mínimo histórico conocido y si el precio actual está en ese mínimo. Así:

- No repite la misma alerta en cada revisión mientras el juego siga al mismo precio mínimo.
- Puede volver a avisar si el juego sale del mínimo y posteriormente lo alcanza otra vez.
- Notifica un nuevo récord cuando el precio baja por debajo del mínimo que ya tenía registrado.

El historial de notificaciones se guarda por separado del estado de precios. El historial conserva hasta 500 alertas.

## Horarios

Revisiones automáticas todos los días:

- 8:00 a. m.
- 12:05 p. m.

Zona horaria: America/Monterrey.

## Configuración de Cloudflare

### Secretos

En Workers & Pages → steam-historical-low → Settings → Variables and Secrets, configura como secretos:

- ITAD_API_KEY
- TELEGRAM_BOT_TOKEN
- TELEGRAM_CHAT_ID

No guardes estos valores en GitHub.

### KV

El Worker utiliza el namespace existente mediante el binding KV.

Claves de estado:

- wishlist-state-v1: mínimo histórico conocido por juego y estado de alerta.
- notification-history-v1: historial de alertas.
- last-run-v1 y last-result-v1: datos de la última revisión.
- telegram-test-sent: evita repetir el mensaje inicial de configuración.

### Despliegue automático

Workers Builds está conectado al repositorio LuisMtz21/steam-historical-low, rama main, con comando:

    npx wrangler deploy

Los archivos del panel están en public/.

## Primera revisión después de reiniciar el historial

La primera revisión vuelve a consultar los mínimos históricos directamente en IsThereAnyDeal. Si un juego ya está al mínimo, puede generar una alerta inicial. Después se guarda la línea base para detectar nuevos mínimos y evitar duplicados.

## Datos del proyecto

- País: México (MX).
- Tienda: Steam (61).
- Moneda de comparación: MXN.
- Estado y notificaciones: Cloudflare KV.
- Automatización: Cloudflare Workers Cron.
- Notificaciones: Telegram.

El proyecto no está afiliado a Steam ni a IsThereAnyDeal.
