# Reto universal: screen sharing sin app

**Pregunta:** ¿podemos enviar a un cliente un enlace que abra en su teléfono, sin instalar nada, y que tras dar permiso nos deje ver su pantalla mientras navega por **otros** sitios y aplicaciones?

**Respuesta corta:** **en el teléfono, no.** Ningún navegador móvil (ni en iPhone ni en Android) implementa la API web de captura de pantalla, y ver otras apps requiere una API nativa del sistema operativo. **En escritorio, sí:** un enlace web basta. La mejor aproximación es una solución híbrida: web en escritorio, co-browsing sin instalación para lo que ocurre dentro de nuestra web, y una app mínima de soporte, instalada con un solo toque, solo cuando de verdad hace falta ver otras apps.

---

## 1. ¿Qué es técnicamente posible?

| Capacidad | Cómo | Instalación |
|---|---|---|
| Compartir pantalla completa, ventana o pestaña **en escritorio** desde un enlace | `navigator.mediaDevices.getDisplayMedia()` + WebRTC. Requiere HTTPS, un gesto del usuario y su permiso explícito en cada sesión [1][2]. Soportado en Chrome 72+, Edge 79+, Firefox 33+ y Safari 13+ [3]. | Ninguna |
| Ver la pantalla completa (otras apps incluidas) en **escritorio** | El usuario elige "Pantalla completa" en el selector del navegador. Chrome permite sugerir el tipo de superficie (`displaySurface`) o excluirla (`monitorTypeSurfaces`) [4]. | Ninguna |
| Ver lo que el cliente hace **dentro de nuestra propia web** en el móvil | Co-browsing: se replica el DOM y los eventos (tipo rrweb [9]) por WebSocket o WebRTC, con cursor remoto y resaltados. No es un vídeo de la pantalla. | Ninguna |
| Ver la pantalla completa del **Android**, incluidas otras apps | API nativa `MediaProjection`: pide consentimiento en cada sesión y, desde Android 14, un foreground service de tipo `mediaProjection`. Android 14+ también permite compartir una sola app [5]. | App nativa |
| Ver la pantalla completa del **iPhone**, incluidas otras apps | ReplayKit con una **Broadcast Upload Extension**: la captura de todo el sistema exige una extensión nativa [6]. Se inicia desde `RPSystemBroadcastPickerView` [7], que está obsoleto desde iOS 27 en favor de `SCContentSharingPicker`, de ScreenCaptureKit [8]. | App nativa |

## 2. ¿Qué no es posible?

1. **Capturar la pantalla desde un navegador móvil.** `getDisplayMedia` **no está soportado** en Safari de iOS, Chrome para Android, Firefox para Android ni Samsung Internet [3]. MDN la marca como *Limited availability*, fuera de Baseline [1]. No hay polyfill posible: es una capacidad del navegador y el sistema operativo, no de JavaScript.
2. **Seguir al usuario fuera de nuestra web con co-browsing.** El co-browsing solo ve el DOM de páginas que controlamos. La política de mismo origen impide observar otros sitios, y las apps nativas quedan completamente fuera.
3. **iOS sin instalar nada.** Las **App Clips** (el "sin instalar" de Apple) **no pueden incluir extensiones de app**, salvo un widget para Live Activities [10]. Por tanto no pueden llevar la Broadcast Upload Extension que exige la captura de todo el sistema.
4. **Android sin instalar nada.** Google Play Instant, que eran las "apps sin instalar" de Android, **se retiró en diciembre de 2025**: ya no se puede publicar y sus APIs dejaron de funcionar [11].
5. **Controlar remotamente un iPhone.** Ni siquiera con una app nativa: iOS no expone ninguna API de inyección de toques a terceros. Solo se puede ver y guiar (voz, anotaciones).
6. **Permiso persistente.** En la web el permiso se pide en cada sesión [1]. En Android, cada `MediaProjection` requiere un nuevo consentimiento, y en Android 14+ el token es de un solo uso [5]. Es una decisión de privacidad, no un bug.

## 3. Diferencias entre iPhone, Android y escritorio

| | **Escritorio** | **Android** | **iPhone** |
|---|---|---|---|
| Captura de pantalla desde el navegador | ✅ `getDisplayMedia` [3] | ❌ [3] | ❌ [3] |
| Ver otras apps y sitios | ✅ eligiendo "pantalla completa" | Solo con app nativa (`MediaProjection`) [5] | Solo con app nativa y Broadcast Extension [6] |
| Opción "sin instalación" nativa | No hace falta | ❌ Instant Apps retiradas [11] | ❌ App Clips sin extensiones [10] |
| Compartir una sola app | Ventana o pestaña | ✅ Android 14+ [5] | Con el selector del sistema [7][8] |
| Control remoto | Con agente nativo (fuera de alcance) | Posible con una app de Accessibility Service (fuera de alcance y con revisión estricta de Play) | ❌ No existe |
| Fricción para el usuario | 1 clic + selector | Instalar app + diálogo del sistema | Instalar app + iniciar la emisión desde el selector o el Centro de Control |

## 4. Qué construiría para acercarnos al máximo

**Un único enlace con escalado progresivo según el dispositivo y la necesidad:**

```
          enlace único (HTTPS, token de un solo uso, caduca en 15 min)
                              │
            ┌─────────────────┼────────────────────────┐
         Escritorio        Móvil: el problema está   Móvil: hay que ver
            │              en NUESTRA web             OTRAS apps o sitios
   getDisplayMedia +            │                          │
   WebRTC (P2P, TURN)     Co-browsing (DOM + eventos,   App de soporte mínima
   sin instalación        rrweb) sin instalación,       (enlace directo a la tienda)
                          con enmascarado de campos     Android: MediaProjection
                          sensibles                     iOS: ReplayKit Broadcast Ext.
                                                        → misma sesión WebRTC
```

1. **Escritorio: 100 % web.** `getDisplayMedia` sugiriendo `displaySurface: "monitor"` [4] y transmitiendo por WebRTC. Esto cumple exactamente lo que se pidió.
2. **Móvil dentro de nuestro producto: co-browsing sin instalación.** Cubre la mayoría de casos de soporte, como guiar un formulario o una cotización. Ventajas: sin instalación, con enmascarado de datos sensibles (tarjetas, documentos de identidad) antes de salir del dispositivo y con anotaciones del agente. Es el camino más rentable y el que construiría primero.
3. **Móvil fuera de nuestro producto: app de soporte ligera**, instalada con un toque desde el mismo enlace. Una pantalla ("Compartir con tu asesor"), un código de sesión y la extensión de broadcast en iOS o `MediaProjection` en Android, reutilizando el mismo backend WebRTC y de señalización. Si ya existe una app propia, se añade ahí.
4. **Alternativa sin instalar para casos puntuales:** videollamada web en la que el cliente usa **otro dispositivo** o la cámara para enseñar la pantalla, o guía por pasos con capturas que el cliente sube. Es rudimentario, pero no requiere instalar nada.

**Requisitos transversales:** consentimiento explícito y visible, un indicador de "compartiendo" permanente, botón para detener siempre accesible, sesiones efímeras, nada grabado por defecto, auditoría de quién vio qué, y avisar de que no se deben mostrar contraseñas ni datos de pago (en co-browsing, enmascararlos automáticamente).

**Recomendación:** entregar primero **1 + 2**, que no requieren instalación y cubren escritorio y nuestra web en móvil. Construir **3** solo si las métricas de soporte muestran que una parte relevante de los casos ocurre fuera de nuestro producto. Y comunicar al negocio, sin ambigüedad, que "ver otras apps del teléfono sin instalar nada" **no es posible hoy** en ninguna de las dos plataformas.

---

## Fuentes

1. MDN, `MediaDevices.getDisplayMedia()`: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
2. W3C, *Screen Capture* (especificación): https://w3c.github.io/mediacapture-screen-share/
3. Can I use, `getDisplayMedia`: https://caniuse.com/mdn-api_mediadevices_getdisplaymedia
4. Chrome for Developers, *Privacy-preserving screen sharing controls*: https://developer.chrome.com/docs/web-platform/screen-sharing-controls
5. Android Developers, *Media projection*: https://developer.android.com/media/grow/media-projection
6. Apple Developer, *ReplayKit*: https://developer.apple.com/documentation/replaykit
7. Apple Developer, `RPSystemBroadcastPickerView`: https://developer.apple.com/documentation/replaykit/rpsystembroadcastpickerview
8. Apple Developer, `SCContentSharingPicker` (iOS 27+): https://developer.apple.com/documentation/screencapturekit/sccontentsharingpicker
9. rrweb (grabación y reproducción del DOM, base habitual del co-browsing): https://github.com/rrweb-io/rrweb
10. Apple Developer, *Choosing the right functionality for your App Clip*: https://developer.apple.com/documentation/appclip/choosing-the-right-functionality-for-your-app-clip
11. Android Authority, *Google is killing Android Instant Apps*: https://www.androidauthority.com/google-killing-android-instant-apps-3567211/

*Consultadas el 29-09-2026. Apple marca `RPSystemBroadcastPickerView` como obsoleto desde iOS 27 y remite a `SCContentSharingPicker`. Eso cambia el selector, no el requisito de tener una app nativa.*
