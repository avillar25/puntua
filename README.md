# Puntúa

Tu IMDb personal para pelis, series y videojuegos: lo que has visto y jugado, tus notas, lo que te queda pendiente y los capítulos nuevos de las series que sigues.

- **Web:** https://avillar25.github.io/puntua (se puede instalar como app desde Chrome o Edge).
- **Android:** descarga el APK de la última versión en **Releases**.
- Entras con tu cuenta (correo y contraseña) y ves lo mismo en cualquier PC o móvil.

## Estructura

- `src/app.html`: la app (HTML, CSS y JavaScript en un solo archivo).
- `src/meta.js`: datos externos (notas de IMDb y Metacritic, duraciones, sagas, emisión de series).
- `src/web-backend.js`: guarda tus datos en el navegador y los sincroniza con tu cuenta de Firebase.
- `src/firebase-config.js` y `firestore.rules`: configuración de Firebase y reglas de seguridad.
- `catalog/`: fichas del catálogo e historiales preparados para importar.
- `images/`: portadas.
- `scripts/build-web.py`: genera `www/` a partir de `src/` y `catalog/`.
- `android/`: proyecto Android generado con Capacitor.

## Licencia

© 2026 avillar25. **Todos los derechos reservados.** El código está a la vista, pero no se permite copiarlo, redistribuirlo, publicarlo en tiendas ni venderlo sin permiso. Ver [LICENSE](LICENSE).

Las notas proceden de IMDb y Metacritic y las duraciones de HowLongToBeat; las portadas son propiedad de sus respectivos titulares.
