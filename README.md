# template-projekt

1. `npm i better-sqlite3`
2. `npm install react react-dom`
3. `npx sichere-actions docs`
4. `npm run dev`
3. http://localhost:5173 öffnen

Login: `admin / 1234`.

Die gesamte fachliche Anwendung steht in `sichere-actions.config.js`. Datenbank, Backend, Frontend, Seeds, Tests, Migrationen und Dokumentation werden daraus abgeleitet.

---

Wenn man etwas an der DB geändert hat kann man die DB aktualisieren mit folgendem Befehl

`npm run db:update`