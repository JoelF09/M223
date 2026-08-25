// Die gesamte fachliche Anwendung. Datenbank, REST-API, Rechte, Validierung,
// Konfliktschutz, Nachvollziehbarkeit und das React-Frontend werden daraus
// abgeleitet - es gibt keine weitere Quelle fuer das Modell.
//
// Frueher war dasselbe Fachmodell auf backend/ (fuenf Schichten,
// handgeschriebener Server, eigene React-Komponenten) und frontend/ verteilt.
// Diese Datei ersetzt das vollstaendig; die alte Version liegt unveraendert
// in _manuelle-vorversion/ (siehe README dort).
//
// Start: npm install, dann npm run dev - http://localhost:5173

import Driver from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import {
  conflict,
  custom,
  defineApp,
  now,
  param,
} from 'sichere-express-actions';
import { SQLiteAuditAdapter, sqlite } from 'sichere-express-actions/sqlite';

// better-sqlite3 statt des eingebauten node:sqlite: Letzteres ist in Node 22
// noch experimentell und meldet das bei jedem Start.
const dbDatei = fileURLToPath(new URL('./data.db', import.meta.url));
const database = sqlite(dbDatei, { driver: new Driver(dbDatei) });

export default defineApp({
  name: 'Autovermietung Flughafen',
  database,
  audit: new SQLiteAuditAdapter(database),
  api: { prefix: '/api' },
  ui: { generated: true, title: 'Autovermietung Flughafen', port: 5173 },
  migrations: { directory: fileURLToPath(new URL('./migrations', import.meta.url)) },
  documentation: {
    title: 'Autovermietung Flughafen',
    directory: fileURLToPath(new URL('./docs/generated', import.meta.url)),
  },

  // Der Header, ueber den sich Hans, Paul und die Administration ausweisen
  // (x-account-id, Standardwert), kommt vom generierten Login-Formular selbst
  // - keine eigene Anmeldeseite noetig.
  auth: {
    resource: 'account',
    username: 'benutzername',
    password: 'passwort',
    role: 'gruppe',
  },

  resources: {
    // Konten legt niemand ueber die API an - das macht ausschliesslich der
    // Seed. documentation.hidden blendet die eigene Navigation aus; lesbar
    // bleibt die Resource trotzdem, damit "Erfasst von" in der
    // Vermietungsliste einen Namen statt nur eine ID zeigt.
    // Kein eigener "path" hier: documentation.hidden nimmt account aus der
    // Liste, die das generierte Frontend zur Pfadauflösung von
    // Referenzfeldern (z. B. vermietung.createdBy) benutzt - danach faellt es
    // auf den Resourcennamen als Pfad zurueck. Ein eigener path wuerde davon
    // abweichen und zu einem 404 fuehren.
    account: {
      operations: { list: true, get: true, create: false, update: false, delete: false },
      documentation: { hidden: true },
      permissions: { read: ['mitarbeiter', 'admin'] },
      fields: {
        benutzername: { type: 'string', required: true, unique: true, min: 3 },
        passwort: { type: 'string', required: true, sensitive: true, min: 4 },
        name: 'string!',
        station: 'string',
        gruppe: ['mitarbeiter', 'admin'],
      },
    },

    kunde: {
      label: 'Kunde',
      pluralLabel: 'Kunden',
      path: '/kunden',
      display: ['vorname', 'nachname'],
      defaultSort: 'nachname',
      audit: true,
      live: true,
      optimisticLock: true,
      permissions: {
        create: ['mitarbeiter', 'admin'],
        update: ['mitarbeiter', 'admin'],
        delete: ['admin'],
      },
      fields: {
        vorname: { type: 'string', required: true, min: 2 },
        nachname: { type: 'string', required: true, min: 2 },
      },
    },

    auto: {
      label: 'Auto',
      pluralLabel: 'Autos',
      path: '/autos',
      display: '{marke} {modell} ({kennzeichen})',
      defaultSort: 'kennzeichen',
      audit: true,
      live: true,
      permissions: { create: ['admin'], update: ['admin'], delete: ['admin'] },
      // Ersetzt das fruehere Statusfeld mit Default+readonly von Hand: Der
      // Workflow legt "status" selbst als Enum an, setzt "verfuegbar" als
      // Startwert und generiert aus der Transition eine eigene Route samt
      // Knopf im Frontend - erscheint automatisch, sobald ein Auto "defekt"
      // ist und die angemeldete Person Admin ist.
      workflow: {
        initial: 'verfuegbar',
        transitions: {
          freigeben: {
            from: 'defekt', to: 'verfuegbar', roles: ['admin'], label: 'Wieder freigeben',
          },
        },
      },
      fields: {
        marke: { type: 'string', required: true, min: 2 },
        modell: { type: 'string', required: true, min: 1 },
        kennzeichen: { type: 'string', required: true, unique: true },
      },
      // "status" sagt nur, ob das Auto defekt ist oder nicht - ob es gerade
      // vermietet ist, steht ausschliesslich in der vermietung-Tabelle (offene
      // Vermietung vorhanden?). Ohne dieses Feld zeigte die Autos-Liste ein
      // vermietetes Auto weiterhin als "verfuegbar" an. Rein berechnet, damit
      // nirgends ein zweiter, redundanter Zustand gepflegt werden muss, der
      // aus dem Takt geraten koennte.
      computed: {
        vermietet: {
          field: { type: 'boolean', label: 'Vermietet' },
          query: {
            resource: 'vermietung',
            where: ({ record }) => ({ autoId: record.id, zurueckgegebenAm: null }),
          },
          aggregate: 'exists',
        },
      },
    },

    vermietung: {
      label: 'Vermietung',
      pluralLabel: 'Vermietungen',
      path: '/vermietungen',
      // Angelegt wird ausschliesslich ueber die Action "vermieten" weiter
      // unten - eine Vermietung ist ein Vorgang mit Vorbedingung (Auto muss
      // frei sein), kein einfacher Datensatz. update:true ab hier nur fuer
      // Auftrag 7 (PUT mit Versionspruefung) - schreibbar bleibt ueber die
      // generierte PUT-Route einzig kundeId (siehe readonly-Felder unten).
      operations: { list: true, get: true, create: false, update: true, delete: false },
      permissions: { update: ['mitarbeiter', 'admin'] },
      audit: true,
      live: true,
      // Auftrag 7, Teil A: optimistisches Sperren. "version" wird von der
      // Framework-Resource selbst ergaenzt (int, generated, default 1) und
      // bei jedem Update via "WHERE id=? AND version=?" geprueft - genau das
      // Muster aus Thema7-Sperrstrategien.md. Bei 0 betroffenen Zeilen
      // unterscheidet die Resource-Service-Schicht selbst zwischen
      // "Datensatz existiert nicht" (404) und "Version veraltet" (409 mit
      // aktueller Version/Zeitpunkt/Daten) - das ist die Stelle aus dem
      // Auftrag, an der es sonst am haeufigsten hakt.
      optimisticLock: true,
      // Auftrag 7, Teil C: pessimistisches Sperren. gesperrtVon/gesperrtAm
      // werden als Spalten "gesperrt_von"/"gesperrt_am" ergaenzt (FK auf
      // account). POST .../sperren und POST .../entsperren entstehen daraus
      // automatisch; eine fremde, noch gueltige Sperre fuehrt beim Sperren
      // *und* beim naechsten PUT zu 423 samt Name (actorDisplay: 'name') und
      // Sperrzeitpunkt. ttl: '10m' ist die Ablaufzeit aus Schritt 12 - ohne
      // sie bliebe eine Vermietung fuer immer blockiert, sobald jemand den
      // Browser zuklappt. overrideRoles ist standardmaessig schon ['admin'].
      editingLock: {
        actorField: 'gesperrtVon',
        atField: 'gesperrtAm',
        actorResource: 'account',
        actorDisplay: 'name',
        roles: ['mitarbeiter', 'admin'],
        ttl: '10m',
        acquirePath: '/sperren',
        releasePath: '/entsperren',
        releaseMethod: 'post',
      },
      // Ersetzt die von Hand gepflegten Felder accountId/erstelltVon/
      // geaendertAm: tracking traegt "wer hat angelegt/zuletzt geaendert"
      // automatisch bei jedem Schreibzugriff nach - aus dem angemeldeten
      // Benutzer, nicht aus dem Formular.
      tracking: { actorResource: 'account' },
      // "Zurueckgeben" ist eine Workflow-Transition statt einer eigenen
      // Action: Sie erzeugt POST /api/vermietungen/:id/rueckgabe von selbst
      // und im generierten Frontend erscheint der Knopf automatisch bei
      // jeder Vermietung mit Status "offen".
      workflow: {
        field: 'status',
        initial: 'offen',
        transitions: {
          rueckgabe: {
            from: 'offen',
            to: 'abgeschlossen',
            roles: ['mitarbeiter', 'admin'],
            label: 'Zurückgeben',
            values: () => ({ zurueckgegebenAm: now() }),
          },
        },
      },
      // "unfall" erreicht dieses Feld nicht ueber eine Transition, sondern
      // ueber die Action "unfallMelden" (schreibt zusammen mit auto.status in
      // derselben Transaktion) - deshalb hier von Hand als Enum deklariert,
      // ergaenzend zu den beiden Workflow-Zustaenden.
      // autoId/zurueckgegebenAm sind readonly: die generierte PUT-Route darf
      // nur kundeId (+ version) aendern - welches Auto und ob zurueckgegeben
      // wurde, laeuft ausschliesslich ueber vermieten() bzw. die
      // rueckgabe-Transition, nicht per freiem Update.
      fields: {
        autoId: { ref: 'auto', required: true, readonly: true },
        kundeId: 'ref:kunde!',
        ausgeliehenAm: { type: 'datetime', required: true, readonly: true },
        zurueckgegebenAm: {
          type: 'datetime', optional: true, nullable: true, readonly: true,
        },
        status: {
          enum: ['offen', 'abgeschlossen', 'unfall'], default: 'offen', readonly: true, filterable: true,
        },
      },
      // Ersetzt den fruehen manuellen SQL-Index in domain/vermietung.js: ein
      // Auto darf hoechstens eine offene (zurueckgegebenAm IS NULL)
      // Vermietung gleichzeitig haben.
      indexes: [
        {
          name: 'auto_nur_einmal_offen', fields: ['autoId'], unique: true, where: { zurueckgegebenAm: null },
        },
      ],
    },

    // Auftrag 6, Teil A: eigenes Protokoll statt des eingebauten
    // "_sichere_audit" - damit Tabelle und Spalten dem Auftragstext
    // entsprechen. feld/alter_wert/neuer_wert kommen laut Auftrag erst
    // spaeter dazu, deshalb noch nicht hier.
    protokoll: {
      label: 'Protokoll',
      pluralLabel: 'Protokoll',
      operations: {
        list: true, get: true, create: false, update: false, delete: false,
      },
      documentation: { hidden: true },
      permissions: { read: ['mitarbeiter', 'admin'] },
      fields: {
        tabelle: { type: 'string', required: true },
        datensatzId: { type: 'string', required: true },
        aktion: { type: 'string', required: true },
        accountId: 'ref:account!',
        zeitpunkt: { type: 'datetime', required: true },
      },
    },
  },

  // "login" entsteht automatisch aus dem auth-Block oben (POST /api/login) -
  // keine eigene Action noetig.
  actions: {
    // Die Race Condition ("zwei Anfragen vermieten gleichzeitig dasselbe
    // Auto") wird an drei Stellen gleichzeitig geschlossen:
    //   lock: true auf autoId serialisiert Anfragen zum selben Auto,
    //   transaction: true haelt Pruefung, INSERT und Protokolleintrag in
    //     einer Transaktion (siehe Thema6-Transaktionen.md, Teil C),
    //   die Pruefung in execute() ist die fachliche Regel selbst.
    //
    // Auftrag 6: die drei Schritte (pruefen, erstelleVermietung,
    // schreibeProtokoll) stehen bewusst als eigene execute()-Funktion da,
    // statt als require()/create()/audit()-Kurzform - so ist Teil A/B (die
    // Schritte einzeln, noch ohne Transaktion) und Teil C (dieselben
    // Schritte in db.transaction()) am Code sichtbar derselbe Ablauf, nur
    // mit/ohne die Klammer "transaction: true" darum.
    vermieten: () => ({
      method: 'post',
      path: '/vermietungen',
      input: {
        autoId: {
          ref: 'auto', required: true, lock: true, label: 'Auto',
        },
        kundeId: { ref: 'kunde', required: true, label: 'Kunde' },
      },
      roles: ['mitarbeiter', 'admin'],
      // TEIL C: alle drei Schritte unten laufen gemeinsam in
      // db.transaction() - siehe Thema6-Transaktionen.md.
      transaction: true,
      execute: async ({ input, repositories, user }) => {
        // Schritt 1: pruefen - bewusst *innerhalb* der Transaktion (siehe
        // Tipp im Auftrag): ausserhalb wuerde zwischen Pruefung und Anlegen
        // wieder ein Fenster fuer die Race Condition entstehen.
        const auto = await repositories.auto.findById(input.autoId);
        if (auto?.status !== 'verfuegbar') throw conflict('Dieses Auto ist derzeit nicht verfuegbar');
        const offeneVermietung = await repositories.vermietung.findOne({
          autoId: input.autoId, zurueckgegebenAm: null,
        });
        if (offeneVermietung) throw conflict('Dieses Auto ist bereits vermietet');

        // Schritt 2: erstelleVermietung() - createdAt/createdBy von Hand
        // gesetzt, weil execute() (anders als die require()/create()-Kurzform)
        // das automatische tracking: { actorResource: 'account' } umgeht.
        const vermietung = await repositories.vermietung.create({
          autoId: input.autoId,
          kundeId: input.kundeId,
          status: 'offen',
          ausgeliehenAm: now(),
          zurueckgegebenAm: null,
          createdAt: now(),
          createdBy: user.id,
        });

        // Schritt 3: schreibeProtokoll()
        await repositories.protokoll.create({
          tabelle: 'vermietung',
          datensatzId: String(vermietung.id),
          aktion: 'vermieten',
          accountId: user.id,
          zeitpunkt: now(),
        });

        return vermietung;
      },
      publish: ({ result }) => ({
        topic: 'vermietung.changed', data: { operation: 'create', resource: 'vermietung', value: result },
      }),
      successStatus: 201,
    }),

    // Zwei Schreibvorgaenge, die zusammengehoeren: die offene Vermietung
    // dieses Autos (falls vorhanden) wird mit Status "unfall" geschlossen,
    // und das Auto selbst wird "defekt". Deshalb eine eigene Action statt
    // einer Workflow-Transition, die immer nur eine Resource aendert.
    unfallMelden: () => ({
      method: 'post',
      path: '/autos/:id/unfall',
      input: {
        autoId: {
          ref: 'auto', required: true, source: param('id'), lock: true, label: 'Auto',
        },
      },
      roles: ['mitarbeiter', 'admin'],
      transaction: true,
      require: [
        custom(
          async ({ input, repositories }) => (
            await repositories.auto.findById(input.autoId)
          )?.status !== 'defekt',
          { error: conflict('Auto ist bereits als defekt gemeldet') },
        ),
      ],
      execute: async ({ input, repositories }) => {
        const laufend = await repositories.vermietung.findOne({ autoId: input.autoId, zurueckgegebenAm: null });
        const vermietung = laufend
          ? await repositories.vermietung.update(laufend.id, { zurueckgegebenAm: now(), status: 'unfall' })
          : null;
        const auto = await repositories.auto.update(input.autoId, { status: 'defekt' });
        return { id: auto.id, auto, vermietung };
      },
      publish: ({ result }) => ({
        topic: 'auto.changed', data: { operation: 'update', resource: 'auto', value: result.auto },
      }),
    }),
  },

  seed: {
    account: [
      {
        benutzername: 'hans', passwort: '1234', name: 'Hans Meier', station: 'Flughafen Schalter 1', gruppe: 'mitarbeiter',
      },
      {
        benutzername: 'paul', passwort: '1234', name: 'Paul Weber', station: 'Flughafen Schalter 2', gruppe: 'mitarbeiter',
      },
      {
        benutzername: 'admin', passwort: '1234', name: 'Admin Person', station: 'Zentrale', gruppe: 'admin',
      },
    ],
    kunde: [
      { vorname: 'Anna', nachname: 'Keller' },
      { vorname: 'Bruno', nachname: 'Steiner' },
      { vorname: 'Carla', nachname: 'Frei' },
    ],
    auto: [
      { marke: 'VW', modell: 'Golf', kennzeichen: 'ZH 100 001' },
      { marke: 'Skoda', modell: 'Octavia', kennzeichen: 'ZH 100 002' },
      { marke: 'Fiat', modell: 'Panda', kennzeichen: 'ZH 100 003' },
    ],
    // Als Funktion, damit die IDs der oben angelegten Datensaetze nachgeschlagen
    // werden koennen, statt sie als "1", "1" zu erraten.
    vermietung: async ({ repositories }) => {
      const golf = await repositories.auto.findOne({ kennzeichen: 'ZH 100 001' });
      const anna = await repositories.kunde.findOne({ vorname: 'Anna', nachname: 'Keller' });
      const hans = await repositories.account.findOne({ benutzername: 'hans' });
      const jetzt = new Date().toISOString();
      return [{
        autoId: golf.id,
        kundeId: anna.id,
        createdBy: hans.id,
        status: 'offen',
        ausgeliehenAm: jetzt,
        zurueckgegebenAm: null,
      }];
    },
  },
});
