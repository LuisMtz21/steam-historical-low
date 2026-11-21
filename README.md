# Steam Historical Low Notifier

Panel web para monitorear la lista pública de deseados de Steam México y recibir notificaciones por Telegram cuando un juego iguala o establece un nuevo mínimo histórico en Steam México.

## Panel de control

La página principal del Worker incluye:

- **Probar ahora:** ejecuta una revisión inmediata de Steam e IsThereAnyDeal y envía un resumen de la prueba por Telegram.
- **Periodo de búsqueda:** permite seleccionar cada 1, 3, 6, 12 o 24 horas.
- **Historial:** conserva hasta 500 notificaciones enviadas, con fecha, juego, precio actual, mínimo histórico y porcentaje de descuento.
- **Estado:** muestra la configuración de las conexiones y los resultados de la última revisión.

No requiere contraseña. Cualquier persona que tenga la URL pública del Worker puede abrir el panel, cambiar la frecuencia, consultar el historial y ejecutar una prueba. No se muestran las claves de API ni el token del bot.

## Cómo funciona la frecuencia

Cloudflare ejecuta el Worker una vez por hora. El monitor consulta el intervalo guardado en KV y solo realiza la búsqueda cuando corresponde. El botón **Probar ahora** fuerza una revisión inmediata sin modificar el periodo configurado.

## Qué hace el monitor

- Lee la wishlist pública de Steam.
- Convierte los Steam AppID a identificadores de IsThereAnyDeal.
- Consulta precios y mínimos históricos exclusivamente para Steam y México.
- Envía alertas de dos tipos:
  - **IGUALÓ SU MÍNIMO HISTÓRICO:** el precio actual alcanza un mínimo histórico que ya se conocía.
  - **NUEVO MÍNIMO HISTÓRICO:** IsThereAnyDeal registra un mínimo menor al que se tenía guardado y el precio actual está en ese mínimo.
- Guarda el estado y el historial en Cloudflare KV para evitar avisos repetidos.

El porcentaje de descuento se toma del campo de descuento que devuelve IsThereAnyDeal para el precio actual de Steam.

## Configuración en Cloudflare

### 1. Variables secretas

En Workers & Pages → steam-historical-low → Settings → Variables and Secrets, agrega como **Secrets**:

- `ITAD_API_KEY`: tu clave de IsThereAnyDeal.
- `TELEGRAM_BOT_TOKEN`: token del bot de Telegram.
- `TELEGRAM_CHAT_ID`: chat ID donde recibirás los avisos.

No guardes estos valores en GitHub.

### 2. KV

El archivo `wrangler.jsonc` utiliza el namespace existente mediante el binding `KV`.

### 3. Workers Builds

- Repositorio: `LuisMtz21/steam-historical-low`
- Rama: `main`
- Directorio raíz: `/`
- Comando de despliegue: `npx wrangler deploy`

Los archivos estáticos del panel están en `public/`.

### 4. Cron

El Cron configurado es `0 * * * *` (una vez por hora, en UTC). La frecuencia efectiva se controla desde el panel y se almacena en KV.

## Primera ejecución

La primera revisión crea la línea base del monitor. No envía alertas por descuentos que ya estaban activos antes de instalarlo. El panel permite ejecutar una prueba manual cuando quieras.

## Notas

- País consultado: `MX`.
- Tienda consultada: Steam (shop ID 61 de IsThereAnyDeal).
- Las comparaciones se hacen en la moneda devuelta por la API; si las monedas no coinciden, el juego se omite.
- Los juegos que IsThereAnyDeal no identifica se omiten.
- El historial conserva las últimas 500 notificaciones.
- El proyecto no está afiliado a Steam ni a IsThereAnyDeal. Consulta y respeta las condiciones de uso de sus servicios.
