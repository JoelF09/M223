export const fachlicheRegressionen = [
  {
    id: 'T-ISO',
    title: 'Rueckgabe bleibt vollstaendig in der isolierten Testdatenbank',
    reset: true,
    steps: [
      {
        request: { method: 'POST', path: '/vermietungen/1/rueckgabe', user: 2 },
        expect: { status: 200 },
      },
      {
        database: { sql: 'SELECT status FROM vermietungen WHERE id = ?', params: [1] },
        expect: { path: '0.status', equals: 'abgeschlossen' },
      },
      {
        database: { sql: 'SELECT status FROM autos WHERE id = ?', params: [1] },
        expect: { path: '0.status', equals: 'frei' },
      },
      {
        database: {
          sql: 'SELECT COUNT(*) AS anzahl FROM protokoll WHERE datensatz_id = ? AND aktion = ?',
          params: [1, 'zurueckgegeben'],
        },
        expect: { path: '0.anzahl', equals: 1 },
      },
    ],
  },
  {
    id: 'T-03',
    title: '20 parallele Vermietungen erzeugen genau einen Gewinner',
    reset: true,
    steps: [
      {
        parallel: {
          count: 20,
          users: [1, 2],
          request: {
            method: 'POST',
            path: '/vermietungen',
            timeoutMs: 10000,
            body: { autoId: 3, kundeId: 1, sofort: true },
          },
        },
        expect: { statusCounts: { 201: 1, 409: 19 } },
      },
      {
        database: {
          sql: `SELECT COUNT(*) AS anzahl,
            MIN(CASE WHEN account_id = erstellt_von AND erstellt_von IN (1, 2) THEN 1 ELSE 0 END) AS actorKorrekt
            FROM vermietungen WHERE auto_id = ? AND zurueckgegeben_am IS NULL`,
          params: [3],
        },
        expect: [
          { path: '0.anzahl', equals: 1 },
          { path: '0.actorKorrekt', equals: 1 },
        ],
      },
      {
        database: { sql: 'SELECT status FROM autos WHERE id = ?', params: [3] },
        expect: { path: '0.status', equals: 'vermietet' },
      },
      {
        database: {
          sql: `SELECT COUNT(*) AS anzahl FROM protokoll
            WHERE aktion = 'erstellt' AND datensatz_id IN
              (SELECT id FROM vermietungen WHERE auto_id = ?)`,
          params: [3],
        },
        expect: { path: '0.anzahl', equals: 1 },
      },
    ],
  },
  {
    id: 'T-04',
    title: 'Eine veraltete Version wird ohne Lost Update abgelehnt',
    reset: true,
    steps: [
      {
        request: {
          method: 'POST', path: '/vermietungen', user: 1,
          body: { autoId: 2, kundeId: 1, sofort: false },
        },
        expect: {
          status: 201,
          body: [
            { path: 'status', equals: 'reserviert' },
            { path: 'version', equals: 1 },
          ],
        },
        capture: { versionKonfliktId: 'id' },
      },
      {
        request: {
          method: 'PUT', path: '/vermietungen/{{versionKonfliktId}}', user: 1,
          body: { autoId: 2, kundeId: 2, version: 1 },
        },
        expect: {
          status: 200,
          body: [
            { path: 'kundeId', equals: 2 },
            { path: 'version', equals: 2 },
          ],
        },
      },
      {
        request: {
          method: 'PUT', path: '/vermietungen/{{versionKonfliktId}}', user: 3,
          body: { autoId: 2, kundeId: 3, version: 1 },
        },
        expect: {
          status: 409,
          body: [
            { path: 'details.code', equals: 'VERSIONSKONFLIKT' },
            { path: 'details.aktuelleVersion', equals: 2 },
            { path: 'details.geaendertVon', equals: 'Hans Meier' },
            { path: 'details.aktuelleDaten.kunde_id', equals: 2 },
          ],
        },
      },
      {
        database: {
          sql: 'SELECT kunde_id AS kundeId, version, geaendert_von AS geaendertVon FROM vermietungen WHERE id = ?',
          params: ['{{versionKonfliktId}}'],
        },
        expect: [
          { path: '0.kundeId', equals: 2 },
          { path: '0.version', equals: 2 },
          { path: '0.geaendertVon', equals: 1 },
        ],
      },
      {
        database: {
          sql: `SELECT COUNT(*) AS anzahl FROM protokoll
            WHERE datensatz_id = ? AND aktion = 'geaendert' AND feld = 'kunde_id'`,
          params: ['{{versionKonfliktId}}'],
        },
        expect: { path: '0.anzahl', equals: 1 },
      },
    ],
  },
  {
    id: 'T-08-09',
    title: 'Sperren werden rollenfest gesetzt, geloest und nach TTL uebernommen',
    reset: true,
    steps: [
      {
        request: { method: 'POST', path: '/vermietungen/1/sperren', user: 1 },
        expect: {
          status: 200,
          body: [
            { path: 'gesperrtVon', equals: 1 },
            { path: 'version', equals: 1 },
          ],
        },
      },
      {
        request: { method: 'POST', path: '/vermietungen/1/sperren', user: 2 },
        expect: {
          status: 423,
          body: [
            { path: 'details.code', equals: 'GESPERRT' },
            { path: 'details.gesperrtVon', equals: 'Hans Meier' },
            { path: 'error.details.ownerId', equals: 1 },
          ],
        },
      },
      {
        request: { method: 'POST', path: '/vermietungen/1/sperren', user: 3 },
        expect: {
          status: 423,
          body: [
            { path: 'details.code', equals: 'GESPERRT' },
            { path: 'error.details.ownerId', equals: 1 },
          ],
        },
      },
      {
        request: {
          method: 'PUT', path: '/vermietungen/1', user: 3,
          body: { autoId: 1, kundeId: 2, version: 1 },
        },
        expect: {
          status: 200,
          body: [
            { path: 'kundeId', equals: 2 },
            { path: 'version', equals: 2 },
            { path: 'gesperrtVon', equals: 1 },
          ],
        },
      },
      {
        request: { method: 'POST', path: '/vermietungen/1/entsperren', user: 2 },
        expect: {
          status: 423,
          body: [
            { path: 'details.code', equals: 'GESPERRT' },
            { path: 'error.details.ownerId', equals: 1 },
          ],
        },
      },
      {
        database: { sql: 'SELECT gesperrt_von AS gesperrtVon, kunde_id AS kundeId, version FROM vermietungen WHERE id = 1' },
        expect: [
          { path: '0.gesperrtVon', equals: 1 },
          { path: '0.kundeId', equals: 2 },
          { path: '0.version', equals: 2 },
        ],
      },
      {
        request: { method: 'POST', path: '/vermietungen/1/entsperren', user: 3 },
        expect: {
          status: 200,
          body: [
            { path: 'gesperrtVon', equals: null },
            { path: 'gesperrtAm', equals: null },
            { path: 'version', equals: 2 },
          ],
        },
      },
      {
        request: { method: 'POST', path: '/vermietungen/1/sperren', user: 2 },
        expect: {
          status: 200,
          body: [
            { path: 'gesperrtVon', equals: 2 },
            { path: 'version', equals: 2 },
          ],
        },
      },
      {
        database: {
          mode: 'run',
          sql: 'UPDATE vermietungen SET gesperrt_am = ? WHERE id = ?',
          params: ['2000-01-01T00:00:00.000Z', 1],
        },
        expect: { changes: 1 },
      },
      {
        request: { method: 'POST', path: '/vermietungen/1/sperren', user: 1 },
        expect: {
          status: 200,
          body: [
            { path: 'gesperrtVon', equals: 1 },
            { path: 'gesperrtAm', includes: 'T' },
            { path: 'version', equals: 2 },
          ],
        },
      },
      {
        request: { method: 'POST', path: '/vermietungen/1/entsperren', user: 1 },
        expect: {
          status: 200,
          body: [
            { path: 'gesperrtVon', equals: null },
            { path: 'gesperrtAm', equals: null },
            { path: 'version', equals: 2 },
          ],
        },
      },
      {
        database: {
          sql: 'SELECT gesperrt_von AS gesperrtVon, gesperrt_am AS gesperrtAm, version FROM vermietungen WHERE id = ?',
          params: [1],
        },
        expect: [
          { path: '0.gesperrtVon', equals: null },
          { path: '0.gesperrtAm', equals: null },
          { path: '0.version', equals: 2 },
        ],
      },
    ],
  },
  {
    id: 'T-10-13',
    title: 'Authentifizierung, Rollen und Datensatzbezug werden erzwungen',
    reset: true,
    steps: [
      {
        request: {
          method: 'PUT', path: '/vermietungen/1',
          body: { autoId: 1, kundeId: 2, version: 1 },
        },
        expect: {
          status: 401,
          body: [{ path: 'code', equals: 'UNAUTHORIZED' }],
        },
      },
      {
        request: { path: '/accounts', user: 1 },
        expect: { status: 403, body: [{ path: 'code', equals: 'FORBIDDEN' }] },
      },
      {
        request: { path: '/accounts', user: 3 },
        expect: { status: 200, body: [{ count: 3 }] },
      },
      {
        request: {
          method: 'POST', path: '/vermietungen', user: 1,
          body: { autoId: 2, kundeId: 1, sofort: false },
        },
        expect: { status: 201 },
        capture: { rollenId: 'id' },
      },
      {
        request: {
          method: 'PUT', path: '/vermietungen/{{rollenId}}', user: 2,
          body: { autoId: 2, kundeId: 2, version: 1 },
        },
        expect: { status: 403, body: [{ path: 'code', equals: 'FORBIDDEN' }] },
      },
      {
        request: {
          method: 'PUT', path: '/vermietungen/{{rollenId}}', user: 3,
          body: { autoId: 2, kundeId: 3, version: 1 },
        },
        expect: {
          status: 200,
          body: [
            { path: 'kundeId', equals: 3 },
            { path: 'version', equals: 2 },
          ],
        },
      },
      {
        request: {
          method: 'POST', path: '/vermietungen/{{rollenId}}/status', user: 2,
          body: { status: 'storniert' },
        },
        expect: { status: 403, body: [{ path: 'code', equals: 'FORBIDDEN' }] },
      },
      {
        database: {
          sql: 'SELECT kunde_id AS kundeId, status, version FROM vermietungen WHERE id = ?',
          params: ['{{rollenId}}'],
        },
        expect: [
          { path: '0.kundeId', equals: 3 },
          { path: '0.status', equals: 'reserviert' },
          { path: '0.version', equals: 2 },
        ],
      },
    ],
  },
  {
    id: 'T-11-14',
    title: 'Vier-Augen-Prinzip blockiert eigene und erlaubt fremde Stornierung',
    reset: true,
    steps: [
      {
        request: {
          method: 'POST', path: '/vermietungen', user: 3,
          body: { autoId: 2, kundeId: 1, sofort: false },
        },
        expect: { status: 201 },
        capture: { vierAugenVerbotId: 'id' },
      },
      {
        request: {
          method: 'POST', path: '/vermietungen/{{vierAugenVerbotId}}/status', user: 3,
          body: { status: 'storniert' },
        },
        expect: {
          status: 403,
          body: [{ path: 'message', includes: 'Vier-Augen-Prinzip' }],
        },
      },
      {
        database: {
          sql: `SELECT v.status, a.status AS autoStatus
            FROM vermietungen v JOIN autos a ON a.id = v.auto_id WHERE v.id = ?`,
          params: ['{{vierAugenVerbotId}}'],
        },
        expect: [
          { path: '0.status', equals: 'reserviert' },
          { path: '0.autoStatus', equals: 'reserviert' },
        ],
      },
      {
        request: {
          method: 'POST', path: '/vermietungen', user: 1,
          body: { autoId: 3, kundeId: 2, sofort: false },
        },
        expect: { status: 201 },
        capture: { vierAugenErlaubtId: 'id' },
      },
      {
        request: {
          method: 'POST', path: '/vermietungen/{{vierAugenErlaubtId}}/status', user: 3,
          body: { status: 'storniert' },
        },
        expect: { status: 200, body: [{ path: 'status', equals: 'storniert' }] },
      },
      {
        database: {
          sql: `SELECT v.status, a.status AS autoStatus,
            CASE WHEN v.zurueckgegeben_am IS NOT NULL THEN 1 ELSE 0 END AS beendet
            FROM vermietungen v JOIN autos a ON a.id = v.auto_id WHERE v.id = ?`,
          params: ['{{vierAugenErlaubtId}}'],
        },
        expect: [
          { path: '0.status', equals: 'storniert' },
          { path: '0.autoStatus', equals: 'frei' },
          { path: '0.beendet', equals: 1 },
        ],
      },
      {
        database: {
          sql: `SELECT
            SUM(CASE WHEN datensatz_id = ? AND aktion = 'statuswechsel' THEN 1 ELSE 0 END) AS verboten,
            SUM(CASE WHEN datensatz_id = ? AND aktion = 'statuswechsel' THEN 1 ELSE 0 END) AS erlaubt
            FROM protokoll`,
          params: ['{{vierAugenVerbotId}}', '{{vierAugenErlaubtId}}'],
        },
        expect: [
          { path: '0.verboten', equals: 0 },
          { path: '0.erlaubt', equals: 1 },
        ],
      },
    ],
  },
  {
    id: 'T-AUDIT',
    title: 'Verlauf protokolliert Erstellen, Aendern und Statuswechsel fachlich',
    reset: true,
    steps: [
      {
        request: {
          method: 'POST', path: '/vermietungen', user: 1,
          body: { autoId: 2, kundeId: 1, sofort: false },
        },
        expect: { status: 201 },
        capture: { auditId: 'id' },
      },
      {
        request: {
          method: 'PUT', path: '/vermietungen/{{auditId}}', user: 1,
          body: { autoId: 2, kundeId: 2, version: 1 },
        },
        expect: { status: 200, body: [{ path: 'version', equals: 2 }] },
      },
      {
        request: {
          method: 'POST', path: '/vermietungen/{{auditId}}/status', user: 2,
          body: { status: 'aktiv' },
        },
        expect: { status: 200, body: [{ path: 'status', equals: 'aktiv' }] },
      },
      {
        request: { method: 'POST', path: '/vermietungen/{{auditId}}/rueckgabe', user: 3 },
        expect: { status: 200, body: [{ path: 'status', equals: 'abgeschlossen' }] },
      },
      {
        request: { path: '/vermietungen/{{auditId}}/verlauf', user: 3 },
        expect: {
          status: 200,
          body: [
            { count: 4 },
            { path: '0.aktion', equals: 'zurueckgegeben' },
            { path: '0.person', equals: 'Admin Person' },
            { path: '1.aktion', equals: 'statuswechsel' },
            { path: '1.person', equals: 'Paul Weber' },
            { path: '2.aktion', equals: 'geaendert' },
            { path: '2.feld', equals: 'kunde_id' },
            { path: '2.person', equals: 'Hans Meier' },
            { path: '2.oldValues.kunde_id', equals: 1 },
            { path: '2.newValues.kunde_id', equals: 2 },
            { path: '3.aktion', equals: 'erstellt' },
          ],
        },
      },
      {
        database: {
          sql: `SELECT
            SUM(CASE WHEN aktion = 'erstellt' THEN 1 ELSE 0 END) AS erstellt,
            SUM(CASE WHEN aktion = 'geaendert' AND feld = 'kunde_id' THEN 1 ELSE 0 END) AS geaendert,
            SUM(CASE WHEN aktion = 'statuswechsel' THEN 1 ELSE 0 END) AS statuswechsel,
            SUM(CASE WHEN aktion = 'zurueckgegeben' THEN 1 ELSE 0 END) AS zurueckgegeben
            FROM protokoll WHERE datensatz_id = ?`,
          params: ['{{auditId}}'],
        },
        expect: [
          { path: '0.erstellt', equals: 1 },
          { path: '0.geaendert', equals: 1 },
          { path: '0.statuswechsel', equals: 1 },
          { path: '0.zurueckgegeben', equals: 1 },
        ],
      },
    ],
  },
  {
    id: 'T-SSE',
    title: 'SSE meldet eine erfolgreich gespeicherte Vermietung an verbundene Clients',
    reset: true,
    steps: [
      {
        sse: {
          path: '/ereignisse',
          topic: 'vermietung-geaendert',
          timeoutMs: 5000,
          trigger: {
            method: 'POST', path: '/vermietungen', user: 1,
            body: { autoId: 2, kundeId: 1, sofort: true },
          },
        },
        expect: {
          status: 201,
          event: 'vermietung-geaendert',
          body: [
            { path: 'autoId', equals: 2 },
            { path: 'status', equals: 'aktiv' },
          ],
          data: [
            { path: 'operation', equals: 'create' },
            { path: 'value.autoId', equals: 2 },
            { path: 'value.status', equals: 'aktiv' },
          ],
        },
      },
      {
        database: {
          sql: `SELECT COUNT(*) AS anzahl FROM vermietungen
            WHERE auto_id = 2 AND status = 'aktiv' AND zurueckgegeben_am IS NULL`,
        },
        expect: { path: '0.anzahl', equals: 1 },
      },
      {
        database: { sql: 'SELECT status FROM autos WHERE id = 2' },
        expect: { path: '0.status', equals: 'vermietet' },
      },
      {
        database: {
          sql: `SELECT COUNT(*) AS anzahl FROM protokoll
            WHERE aktion = 'erstellt' AND datensatz_id IN
              (SELECT id FROM vermietungen WHERE auto_id = 2)`,
        },
        expect: { path: '0.anzahl', equals: 1 },
      },
    ],
  },
  {
    id: 'T-05',
    title: 'Ein Fehler im Autoeffekt rollt die gesamte Vermietung zurueck',
    reset: true,
    steps: [
      {
        database: {
          mode: 'run',
          sql: `CREATE TEMP TRIGGER rollback_autostatus
            BEFORE UPDATE OF status ON autos
            WHEN NEW.id = 2 AND NEW.status = 'vermietet'
            BEGIN
              SELECT RAISE(ABORT, 'ERZWUNGENER_ROLLBACK_TEST');
            END`,
        },
      },
      {
        request: {
          method: 'POST', path: '/vermietungen', user: 1,
          body: { autoId: 2, kundeId: 1, sofort: true },
        },
        expect: {
          status: 500,
          body: [
            { path: 'fehler', equals: 'Interner Serverfehler' },
            { path: 'code', equals: 'INTERNAL_ERROR' },
            { path: 'message', equals: 'Interner Serverfehler' },
          ],
        },
      },
      {
        database: {
          sql: `SELECT COUNT(*) AS gesamt,
            SUM(CASE WHEN zurueckgegeben_am IS NULL THEN 1 ELSE 0 END) AS offen
            FROM vermietungen`,
        },
        expect: [
          { path: '0.gesamt', equals: 1 },
          { path: '0.offen', equals: 1 },
        ],
      },
      {
        database: { sql: 'SELECT status FROM autos WHERE id = 2' },
        expect: { path: '0.status', equals: 'frei' },
      },
      {
        database: { sql: 'SELECT COUNT(*) AS anzahl FROM protokoll' },
        expect: { path: '0.anzahl', equals: 1 },
      },
      {
        database: { mode: 'run', sql: 'DROP TRIGGER rollback_autostatus' },
      },
      {
        request: {
          method: 'POST', path: '/vermietungen', user: 1,
          body: { autoId: 2, kundeId: 1, sofort: true },
        },
        expect: {
          status: 201,
          body: [
            { path: 'autoId', equals: 2 },
            { path: 'status', equals: 'aktiv' },
          ],
        },
      },
    ],
    cleanup: [{ database: { mode: 'run', sql: 'DROP TRIGGER IF EXISTS rollback_autostatus' } }],
  },
  {
    // Der gelieferte Endstand liest bei Fehlern ausschliesslich `fehler` und
    // `details`, laeuft auf einem eigenen Port und ignoriert die Erfolgsbodies
    // bis auf die neue `id`. Genau das wird hier nachgewiesen.
    id: 'T-HTTP',
    title: 'Fehler-, Erfolgs- und CORS-Antworten bleiben zum Endstand kompatibel',
    reset: true,
    steps: [
      {
        request: {
          method: 'POST', path: '/vermietungen', user: 1,
          body: { autoId: 'zwei', kundeId: 1, sofort: true },
        },
        expect: {
          status: 400,
          body: [
            { path: 'fehler', equals: 'Ungueltige Eingabe' },
            { path: 'code', equals: 'VALIDATION_ERROR' },
            { path: 'details.0.field', equals: 'autoId' },
          ],
        },
      },
      {
        database: { sql: 'SELECT COUNT(*) AS anzahl FROM vermietungen WHERE auto_id = 2' },
        expect: { path: '0.anzahl', equals: 0 },
      },
      {
        request: {
          method: 'POST', path: '/vermietungen', user: 1,
          body: { autoId: 2, kundeId: 1, sofort: false },
        },
        expect: {
          status: 201,
          body: [
            { path: 'status', equals: 'reserviert' },
            { path: 'auto_id', equals: 2 },
            { path: 'kunde_id', equals: 1 },
          ],
        },
        capture: { httpVorgangId: 'id' },
      },
      {
        request: { method: 'POST', path: '/vermietungen/{{httpVorgangId}}/sperren', user: 1 },
        expect: { status: 200, body: [{ path: 'ok', equals: true }, { path: 'gesperrt_von', equals: 1 }] },
      },
      {
        request: {
          method: 'PUT', path: '/vermietungen/{{httpVorgangId}}', user: 1,
          body: { autoId: 2, kundeId: 2, version: 1 },
        },
        expect: {
          status: 200,
          body: [
            { path: 'ok', equals: true },
            { path: 'kunde_id', equals: 2 },
            { path: 'version', equals: 2 },
          ],
        },
      },
      {
        request: { method: 'POST', path: '/vermietungen/{{httpVorgangId}}/entsperren', user: 1 },
        expect: { status: 200, body: [{ path: 'ok', equals: true }, { path: 'gesperrt_von', equals: null }] },
      },
      {
        request: {
          method: 'POST', path: '/vermietungen/{{httpVorgangId}}/status', user: 1,
          body: { status: 'aktiv' },
        },
        expect: { status: 200, body: [{ path: 'ok', equals: true }, { path: 'status', equals: 'aktiv' }] },
      },
      {
        request: { method: 'POST', path: '/vermietungen/{{httpVorgangId}}/rueckgabe', user: 2 },
        expect: {
          status: 200,
          body: [{ path: 'ok', equals: true }, { path: 'status', equals: 'abgeschlossen' }],
        },
      },
      {
        request: {
          method: 'OPTIONS', path: '/vermietungen',
          headers: {
            origin: 'http://localhost:5173',
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'content-type, x-account-id',
          },
        },
        expect: {
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': { includes: 'POST' },
            'access-control-allow-headers': { includes: 'x-account-id' },
          },
        },
      },
      {
        request: { method: 'GET', path: '/vermietungen', headers: { origin: 'http://localhost:5173' } },
        expect: { status: 200, headers: { 'access-control-allow-origin': '*' } },
      },
    ],
  },
  {
    // Auch beim Bearbeiten schuetzt der partielle UNIQUE-Index: Ein Auto kann
    // nicht zweimal gleichzeitig vermietet sein.
    id: 'T-BELEGT',
    title: 'Ein belegtes Auto wird auch beim Bearbeiten abgelehnt',
    reset: true,
    steps: [
      {
        request: {
          method: 'POST', path: '/vermietungen', user: 1,
          body: { autoId: 2, kundeId: 1, sofort: false },
        },
        expect: { status: 201 },
        capture: { belegtId: 'id' },
      },
      {
        request: {
          method: 'PUT', path: '/vermietungen/{{belegtId}}', user: 1,
          body: { autoId: 1, kundeId: 1, version: 1 },
        },
        expect: {
          status: 409,
          body: [
            { path: 'details.code', equals: 'AUTO_BELEGT' },
            { path: 'fehler', equals: 'Dieses Auto ist bereits vermietet' },
          ],
        },
      },
      {
        database: { sql: 'SELECT auto_id AS autoId, version FROM vermietungen WHERE id = ?', params: ['{{belegtId}}'] },
        expect: [
          { path: '0.autoId', equals: 2 },
          { path: '0.version', equals: 1 },
        ],
      },
      {
        database: { sql: 'SELECT status FROM autos WHERE id IN (1, 2) ORDER BY id' },
        expect: [
          { path: '0.status', equals: 'vermietet' },
          { path: '1.status', equals: 'reserviert' },
        ],
      },
    ],
  },
  {
    // Stammdaten duerfen gepflegt werden - aber nur von den richtigen Rollen,
    // und ohne dass ein Passwort nach aussen gelangt.
    id: 'T-STAMM',
    title: 'Kunden, Autos und Konten werden rollenfest gepflegt',
    reset: true,
    steps: [
      {
        request: { method: 'POST', path: '/kunden', body: { vorname: 'Dora', nachname: 'Meier' } },
        expect: { status: 401 },
      },
      {
        request: { method: 'POST', path: '/kunden', user: 1, body: { vorname: 'Dora', nachname: 'Meier' } },
        expect: { status: 201, body: { path: 'nachname', equals: 'Meier' } },
        capture: { stammKundeId: 'id' },
      },
      {
        request: {
          method: 'PUT', path: '/kunden/{{stammKundeId}}', user: 2,
          body: { vorname: 'Dora', nachname: 'Meier-Frei' },
        },
        expect: { status: 200, body: { path: 'nachname', equals: 'Meier-Frei' } },
      },
      {
        request: { method: 'DELETE', path: '/kunden/{{stammKundeId}}', user: 1 },
        expect: { status: 403 },
      },
      {
        request: { method: 'DELETE', path: '/kunden/{{stammKundeId}}', user: 3 },
        expect: { status: 200 },
      },
      {
        // Kunde 1 haengt an der laufenden Vermietung: Der Fremdschluessel
        // schuetzt den Datenbestand und meldet einen Konflikt statt SQL.
        request: { method: 'DELETE', path: '/kunden/1', user: 3 },
        expect: { status: 409 },
      },
      {
        request: {
          method: 'POST', path: '/autos', user: 1,
          body: { marke: 'Opel', modell: 'Corsa', kennzeichen: 'ZH 100 004' },
        },
        expect: { status: 201, body: { path: 'status', equals: 'frei' } },
      },
      {
        request: {
          method: 'POST', path: '/accounts', user: 1,
          body: { benutzername: 'neu', passwort: 'geheim', name: 'Neue Person', station: 'Schalter 3', gruppe: 'mitarbeiter' },
        },
        expect: { status: 403 },
      },
      {
        request: {
          method: 'POST', path: '/accounts', user: 3,
          body: { benutzername: 'neu', passwort: 'geheim', name: 'Neue Person', station: 'Schalter 3', gruppe: 'mitarbeiter' },
        },
        expect: {
          status: 201,
          body: [
            { path: 'benutzername', equals: 'neu' },
            { path: 'passwort', absent: true },
          ],
        },
      },
      {
        database: { sql: "SELECT gruppe, passwort FROM account WHERE benutzername = 'neu'" },
        expect: [
          { path: '0.gruppe', equals: 'mitarbeiter' },
          { path: '0.passwort', equals: 'geheim' },
        ],
      },
      {
        request: { method: 'GET', path: '/kunden' },
        expect: { status: 200, body: { count: 3 } },
      },
    ],
  },
  {
    // Der Autostatus haengt am Vorgang. Aendert er sich, muessen andere
    // Arbeitsplaetze das sofort erfahren und nicht erst beim naechsten
    // Polling-Durchgang.
    id: 'T-LIVE-AUTO',
    title: 'Statuswechsel und Autowechsel melden auto.changed an alle Clients',
    reset: true,
    steps: [
      {
        sse: {
          topic: 'auto.changed',
          trigger: { method: 'POST', path: '/vermietungen/1/rueckgabe', user: 2 },
        },
        expect: {
          status: 200,
          event: 'auto.changed',
          data: [
            { path: 'resource', equals: 'auto' },
            { path: 'value.id', equals: 1 },
            { path: 'value.status', equals: 'frei' },
          ],
        },
      },
      {
        request: {
          method: 'POST', path: '/vermietungen', user: 1,
          body: { autoId: 2, kundeId: 1, sofort: false },
        },
        expect: { status: 201, body: { path: 'status', equals: 'reserviert' } },
        capture: { liveVorgangId: 'id' },
      },
      {
        sse: {
          topic: 'auto.changed',
          trigger: {
            method: 'PUT', path: '/vermietungen/{{liveVorgangId}}', user: 1,
            body: { autoId: 3, kundeId: 1, version: 1 },
          },
        },
        expect: {
          status: 200,
          event: 'auto.changed',
          data: [
            { path: 'value.id', equals: 2 },
            { path: 'value.status', equals: 'frei' },
          ],
        },
      },
      {
        database: { sql: 'SELECT id, status FROM autos WHERE id IN (2, 3) ORDER BY id' },
        expect: [
          { path: '0.status', equals: 'frei' },
          { path: '1.status', equals: 'reserviert' },
        ],
      },
    ],
  },
  {
    // Der Endstand protokolliert nur tatsaechliche Aenderungen. Ein Speichern
    // ohne Aenderung darf keine Zeile erzeugen, die eine behauptet.
    id: 'T-AUDIT-LEER',
    title: 'Speichern ohne fachliche Aenderung erzeugt keinen Protokolleintrag',
    reset: true,
    steps: [
      {
        request: {
          method: 'POST', path: '/vermietungen', user: 1,
          body: { autoId: 2, kundeId: 1, sofort: false },
        },
        expect: { status: 201 },
        capture: { leerVorgangId: 'id' },
      },
      {
        database: {
          sql: 'SELECT COUNT(*) AS anzahl FROM protokoll WHERE datensatz_id = ?',
          params: ['{{leerVorgangId}}'],
        },
        expect: { path: '0.anzahl', equals: 1 },
      },
      {
        request: {
          method: 'PUT', path: '/vermietungen/{{leerVorgangId}}', user: 1,
          body: { autoId: 2, kundeId: 1, version: 1 },
        },
        expect: { status: 200, body: [{ path: 'ok', equals: true }, { path: 'version', equals: 2 }] },
      },
      {
        database: {
          sql: `SELECT COUNT(*) AS anzahl,
              SUM(CASE WHEN feld IS NULL THEN 1 ELSE 0 END) AS ohneFeld
            FROM protokoll WHERE datensatz_id = ?`,
          params: ['{{leerVorgangId}}'],
        },
        expect: [
          { path: '0.anzahl', equals: 1 },
          { path: '0.ohneFeld', equals: 0 },
        ],
      },
      {
        request: {
          method: 'PUT', path: '/vermietungen/{{leerVorgangId}}', user: 1,
          body: { autoId: 2, kundeId: 2, version: 2 },
        },
        expect: { status: 200, body: { path: 'kunde_id', equals: 2 } },
      },
      {
        database: {
          sql: `SELECT aktion, feld, alter_wert AS alt, neuer_wert AS neu
            FROM protokoll WHERE datensatz_id = ? ORDER BY id`,
          params: ['{{leerVorgangId}}'],
        },
        expect: [
          { count: 2 },
          { path: '1.aktion', equals: 'geaendert' },
          { path: '1.feld', equals: 'kunde_id' },
          { path: '1.alt', equals: '1' },
          { path: '1.neu', equals: '2' },
        ],
      },
    ],
  },
];