# Centro de Comando de Incidentes

Herramienta para que un ingeniero de guardia **detecte incidentes, correlacione eventos entre fuentes, estime el impacto en usuarios, identifique la causa probable con evidencia y reciba un siguiente paso seguro**. Cada afirmación va etiquetada como **sabemos** (está en los datos, con referencia al evento), **inferimos** (razonamiento explícito) o **por verificar** (lo que los datos no permiten afirmar).

- **UI web:** panel con el siguiente paso seguro, impacto, incidentes, hechos, inferencias e incógnitas, gráfico de correlación temporal, mapa de asientos, hipótesis con evidencia a favor y en contra, y línea de tiempo unificada con filtros. Cualquier referencia (`server:5`, `heartbeat:S003`…) salta al evento correspondiente.
- **CLI:** el mismo informe en la terminal (`npm run report`), o en JSON (`--json`) para integrarlo con bots o alertas.
- **API:** `GET /api/report` y `POST /api/analyze`.
- **Sin dependencias.** Node ≥ 20. El motor es un módulo ES puro que se ejecuta igual en Node y en el navegador.

## Ejecutar

```bash
npm start            # http://localhost:3000  (PORT=xxxx para cambiarlo)
npm test             # 12 pruebas del motor
npm run report       # informe en la terminal
node src/cli.js ruta/a/otros/logs --json
```

La UI también funciona en cualquier hosting estático (GitHub Pages, Netlify, Vercel), porque el análisis corre en el navegador. Con el botón **Cargar archivos** se analizan logs nuevos: los archivos no salen del equipo.

## Arquitectura

```
data/                    fuentes sintéticas (sin datos reales)
src/engine/parse.js      parsers → eventos normalizados {id, source, ms (UTC), rawTs, tzOffset, level, type, fields}
src/engine/analyze.js    detectores → hechos/inferencias/incógnitas → hipótesis → incidentes → impacto → recomendación
src/node/load.js         carga desde disco (una fuente ausente se reporta como brecha, no rompe)
src/cli.js               informe en terminal / JSON
server.js                estáticos + API, sin dependencias, protegido contra path traversal
index.html, public/      UI (JS vanilla, SVG propio, modo claro/oscuro, responsive)
test/engine.test.js      pruebas del motor
docs/SCREEN_SHARING.md   respuesta al reto universal
```

Las reglas son **genéricas**, no están ajustadas a este dataset: orden temporal entre el inicio de un síntoma y un cambio, cohortes de heartbeats, confirmación por dos señales independientes (el cliente deja de latir y el servidor no lo alcanza), atributos que distinguen a los afectados de los sanos, health checks que pasan por proxy, bucles de reinicio sin arranque posterior y carriers degradados frente a sanos. Una de las pruebas desplaza el deploy antes del corte y comprueba que la hipótesis "el deploy lo causó" pasa a *probable*.

---

## Respuestas escritas

### 1. ¿Qué está pasando?

Hay **tres problemas distintos que coinciden en la misma ventana de 10 minutos**. La herramienta los separa:

| | Incidente | Sev. | Estado |
|---|---|---|---|
| INC-1 | **3 asientos desconectados** (S003, S007, S014) desde las 13:03:00Z | SEV-2 | Activo: el servidor sigue sin alcanzarlos a las 13:09:44Z |
| INC-3 | **Autenticación con el carrier Beta**: `401 session_expired` justo después de un login correcto | SEV-3 | Externo, activo |
| INC-2 | **Deploy fallido 2026.09.29.5**: le falta el export `normalizeCallIndex`; healthcheck fallido y deploy detenido | SEV-3 | Contenido, pero la recuperación **no está verificada** |

### 2. Impacto en usuarios

- **Confirmado:** 3 de 20 asientos (15 %), 2 en Demo Agency A y 1 en Demo Agency B. **Ninguno tenía una llamada activa**: lo que se pierde es capacidad para atender llamadas nuevas, no llamadas en curso.
- **En riesgo (inferido):** si el origen de `live-call-server` no quedó sano tras los 4 reinicios, estarían expuestos los otros 17 asientos y las **3 llamadas activas** (S002, S005, S011).
- **Externo:** las cotizaciones con Beta fallan (2 de 3 peticiones); Alpha funciona. No hay datos para saber cuántos usuarios cotizan con Beta.

### 3. Causa probable y por qué el error más ruidoso no lo es

La trampa del dataset es la zona horaria: `deploy.log` está en **-05:00**. Leído tal cual, el deploy parece ocurrir a las 08:04; normalizado, empieza a las **13:04:50Z**.

- Los tres asientos dejaron de latir a las **13:03:00Z** y el primer error websocket (S014) es de las **13:03:11Z**. Ambos son **110 s anteriores** al deploy. El deploy, que es lo más ruidoso (error de import y 4 reinicios), **queda descartado como causa de la caída de asientos**.
- La causa de la desconexión **aún no se conoce**. Lo que sabemos: los tres asientos se cortaron en el mismo segundo, lo que sugiere una causa común; no comparten agencia; usan el mismo build que 12 asientos sanos. Hipótesis principal (60 %): un problema de conectividad de cliente o red. Falta evidencia del lado del cliente.
- El build candidato **sí está roto** (90 %): falta el export `normalizeCallIndex`. El preflight lo aprobó, lo que revela una brecha en el pipeline.
- La proximidad de 45 s entre el fallo de Beta y el corte **no demuestra relación**: no hay ningún dato que vincule asientos con carriers.
- Los 5 clientes con el build antiguo (2026.09.28.9) están todos sanos: el desfase de versiones queda descartado como causa.

### 4. Siguiente paso seguro

1. **Congelar despliegues y no aplicar todavía el patch de fix-forward.** Hay 3 llamadas activas, desplegar reinicia `live-call-server`, y el patch no arregla la caída de asientos, que empezó antes del deploy.
2. **Verificar el origen sin pasar por Cloudflare (solo lectura):** `/health` directo, `systemctl status` y el build en ejecución. El `/health 200` de las 13:06:00Z pasó por el proxy y puede ser caché del edge. *Si el origen corre 2026.09.29.5 o no responde, hacer rollback a 2026.09.29.4, a ser posible sin llamadas activas en el nodo.*
3. **Contactar a los agentes de S003, S007 y S014** (recargar el cliente, revisar su red y recoger logs). No tienen llamadas activas, así que el riesgo es nulo.
4. **Carrier Beta:** abrir un caso y revisar credenciales o sesión; mientras tanto, cotizar con Alpha si el negocio lo permite.

Después: añadir al preflight una comprobación de imports/exports; hacer que el healthcheck post-deploy consulte el origen y no el CDN; desplegar el patch como canary, probándolo con clientes 2026.09.28.9.

### 5. Qué sigue sin verificarse

- La hora de captura de `client-heartbeats.json`. Ningún heartbeat es posterior a las 13:04:55Z, pero los logs siguen hasta las 13:09:44Z. O es una foto tomada en ese momento, o **toda la flota dejó de reportar**. Es la incógnita que más cambiaría la severidad. El servidor sigue escribiendo logs a las 13:09:42Z, lo que argumenta en contra de una caída total.
- Qué build corre ahora y si el proceso quedó estable. No hay log de arranque ni de rollback después de los reinicios.
- Si las llamadas activas sobrevivieron a los reinicios, y si `seats.json` (que no tiene marca de tiempo) sigue vigente.
- Si el patch es compatible con los clientes de build antiguo.

### 6. Decisiones y priorización (60 min)

- **Motor primero, UI después.** El valor está en el razonamiento correcto; por eso el motor es puro, está probado y lo usan igual la UI, la CLI y la API.
- **La honestidad epistémica como parte del modelo de datos.** Cada afirmación tiene `kind` y `refs`, y una prueba verifica que toda referencia exista. Esto evita la "confianza inventada" típica de los dashboards.
- **Reglas explicables en lugar de ML o LLM en el análisis.** En un incidente, el ingeniero necesita saber *por qué* la herramienta concluye algo y poder auditarlo. Con 42 eventos, un modelo estadístico no aporta nada.
- **Recomendaciones conservadoras:** primero acciones de solo lectura, cada paso con su riesgo y ramas condicionales ("si X, entonces rollback"), además de una lista explícita de lo que **no** hay que hacer.
- **Cero dependencias:** despliegue trivial, sin superficie de supply chain y arranque inmediato.
- **Fuera de alcance, a propósito:** ingesta en streaming, persistencia, autenticación, multi-incidente y correlación con más fuentes.

### 7. Con más tiempo

Ingesta continua (tail de logs o webhooks) con recálculo en vivo; heartbeats con hora de captura explícita; un modelo de dependencias entre servicios para propagar impacto; historial de incidentes y exportación del postmortem; integración con Slack o PagerDuty usando `/api/report`; y una capa de LLM **solo para redactar** el resumen a partir de las afirmaciones ya verificadas, nunca para generar hechos.

### 8. Uso de IA

Usé Claude Code como par de programación: para leer y correlacionar las fuentes, generar el esqueleto del motor, la UI y las pruebas, e investigar la API de screen sharing con fuentes primarias. Revisé cada conclusión contra los datos crudos; por ejemplo, la normalización de zona horaria y el orden temporal que descarta el deploy están cubiertos por pruebas.

---

## Reto universal: screen sharing

Ver [docs/SCREEN_SHARING.md](docs/SCREEN_SHARING.md). En resumen: en escritorio es posible con un enlace (`getDisplayMedia` y WebRTC). En iPhone y Android **no** es posible sin instalar nada: ningún navegador móvil soporta la captura de pantalla, las App Clips no admiten la extensión de broadcast y las Instant Apps de Android se retiraron. La recomendación es un enlace único con escalado progresivo: web en escritorio, co-browsing sin instalación para nuestra propia web en móvil y una app de soporte mínima solo cuando haya que ver otras apps.
