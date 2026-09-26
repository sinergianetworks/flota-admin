// Configuración de runtime. En Docker este archivo se regenera al arrancar el
// contenedor a partir de las variables de entorno (ver docker/40-env-config.sh).
// En desarrollo queda vacío y se usan las variables VITE_* de .env.local.
window.__ENV__ = {};
