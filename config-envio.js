// ===== config-envio.js =====
// URL fija del Apps Script. Reemplaza por la URL real de tu deployment.
const GAS_URL = "https://script.google.com/macros/s/TU_ID_DE_DEPLOYMENT/exec";

const ENVIO_CONFIG = {
  maxReintentos: 4,          // número de intentos totales
  esperaBaseMs: 1500,        // espera inicial entre reintentos
  timeoutMs: 20000,          // tiempo máximo por intento antes de abortar
  storageKey: "dmf_pedido_pendiente" // para respaldo local del formulario
};

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Guarda el pedido en localStorage antes de intentar enviarlo
function guardarBorradorLocal(payload) {
  try {
    localStorage.setItem(ENVIO_CONFIG.storageKey, JSON.stringify({
      payload,
      guardadoEn: new Date().toISOString()
    }));
  } catch (e) {
    console.warn("No se pudo guardar borrador local:", e);
  }
}

// Borra el borrador local solo cuando el envío fue exitoso
function limpiarBorradorLocal() {
  try {
    localStorage.removeItem(ENVIO_CONFIG.storageKey);
  } catch (e) {
    console.warn("No se pudo limpiar borrador local:", e);
  }
}

// Revisa si hay un pedido sin enviar de una sesión anterior
function recuperarBorradorLocal() {
  try {
    const raw = localStorage.getItem(ENVIO_CONFIG.storageKey);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

// Hace un fetch con timeout controlado (AbortController)
function fetchConTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeoutId));
}

/**
 * Envía el pedido al Apps Script con reintentos automáticos y backoff exponencial.
 * @param {Object} payload - Los datos del formulario a enviar.
 * @param {Object} callbacks - { onIntentoFallido, onReintentando, onExito, onErrorFinal }
 * @returns {Promise<Object>} - Respuesta del servidor si tuvo éxito.
 */
async function enviarPedido(payload, callbacks = {}) {
  const {
    onIntentoFallido = () => {},
    onReintentando = () => {},
    onExito = () => {},
    onErrorFinal = () => {}
  } = callbacks;

  // Respaldo local antes de intentar, por si el usuario recarga o pierde conexión
  guardarBorradorLocal(payload);

  if (!navigator.onLine) {
    onErrorFinal(new Error("Sin conexión a internet. El pedido se guardó localmente y puedes reintentarlo cuando recuperes la conexión."));
    return null;
  }

  let ultimoError = null;
  const targetUrl = (typeof SCRIPT_URL !== 'undefined' && SCRIPT_URL.indexOf('http') === 0) ? SCRIPT_URL : GAS_URL;

  for (let intento = 1; intento <= ENVIO_CONFIG.maxReintentos; intento++) {
    try {
      const response = await fetchConTimeout(
        targetUrl,
        {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" }, // evita preflight CORS con Apps Script
          body: JSON.stringify(payload)
        },
        ENVIO_CONFIG.timeoutMs
      );

      if (!response.ok) {
        throw new Error(`Respuesta HTTP no válida: ${response.status}`);
      }

      const data = await response.json();

      if (data.success === false) {
        // El servidor respondió pero reportó un error de negocio (no reintentar infinito por esto)
        throw new Error(data.error || "El servidor reportó un error al procesar el pedido.");
      }

      // Éxito: limpiar respaldo local y notificar
      limpiarBorradorLocal();
      onExito(data);
      return data;

    } catch (err) {
      ultimoError = err;
      onIntentoFallido(intento, err);

      const esUltimoIntento = intento === ENVIO_CONFIG.maxReintentos;
      if (esUltimoIntento) break;

      const espera = ENVIO_CONFIG.esperaBaseMs * Math.pow(2, intento - 1); // backoff exponencial
      onReintentando(intento + 1, espera);
      await esperar(espera);
    }
  }

  // Todos los intentos fallaron: el borrador local queda guardado a propósito
  onErrorFinal(ultimoError);
  return null;
}
