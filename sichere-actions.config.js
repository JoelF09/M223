import { fileURLToPath } from 'node:url';
import {
  ConflictError,
  ForbiddenError,
  HttpError,
  MemoryEventBus,
  NotFoundError,
  conflict,
  defineApp,
  notExists,
  param,
} from 'sichere-express-actions';
import { sqlite } from 'sichere-express-actions/sqlite';
import { fachlicheRegressionen } from './tests/fachliche-regressionen.js';

const PRODUKTIONS_DATENBANK = fileURLToPath(new URL('./vermietung.db', import.meta.url));

const STATUS = ['offen', 'reserviert', 'aktiv', 'abgeschlossen', 'storniert'];
const ENDZUSTAENDE = new Set(['abgeschlossen', 'storniert']);
const WECHSEL = Object.freeze({
  offen: ['reserviert', 'storniert'],
  reserviert: ['aktiv', 'storniert'],
  aktiv: ['abgeschlossen'],
  abgeschlossen: [],
  storniert: [],
});
const AUTOSTATUS = Object.freeze({
  offen: 'frei',
  reserviert: 'reserviert',
  aktiv: 'vermietet',
  abgeschlossen: 'frei',
  storniert: 'frei',
});

function verborgenesAlias(quelle, type = 'string') {
  return {
    field: { type, readonly: true, optional: true, nullable: true, hidden: true },
    compute: ({ record }) => record[quelle],
  };
}

function nachschlagen(resource, idFeld, wertFeld, {
  type = 'string',
  hidden = false,
  label,
} = {}) {
  return {
    field: { type, readonly: true, optional: true, nullable: true, hidden, label },
    compute: async ({ record, repositories }) => {
      const id = record[idFeld];
      if (id == null) return null;
      return (await repositories[resource].findById(id))?.[wertFeld] ?? null;
    },
  };
}

function dbWert(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function auditWert(value) {
  if (value === null || value === undefined) return undefined;
  try { return JSON.parse(value); }
  catch { return value; }
}

function protokollFeld(name) {
  return ({
    autoId: 'auto_id',
    kundeId: 'kunde_id',
    accountId: 'account_id',
    ausgeliehenAm: 'ausgeliehen_am',
    zurueckgegebenAm: 'zurueckgegeben_am',
    erstelltVon: 'erstellt_von',
    geaendertAm: 'geaendert_am',
    geaendertVon: 'geaendert_von',
    gesperrtVon: 'gesperrt_von',
    gesperrtAm: 'gesperrt_am',
  })[name] ?? name;
}

class ProtokollAuditAdapter {
  constructor(db) {
    this.database = db;
  }

  async initialize() {}

  async write(entry) {
    if (entry.resource !== 'vermietung' || entry.resourceId == null || entry.actorId == null) return;

    let aktion = 'geaendert';
    if (entry.action === 'erstellt' || entry.action?.endsWith('.create')) aktion = 'erstellt';
    else if (entry.action?.includes('transition:')) aktion = 'statuswechsel';
    else if (entry.action === 'zurueckgegeben') aktion = 'zurueckgegeben';

    const namen = new Set([
      ...Object.keys(entry.oldValues ?? {}),
      ...Object.keys(entry.newValues ?? {}),
    ]);
    let aenderungen = [...namen]
        .filter((name) => !Object.is(entry.oldValues?.[name], entry.newValues?.[name]))
        .map((name) => ({
          feld: protokollFeld(name),
          alt: entry.oldValues?.[name],
          neu: entry.newValues?.[name],
        }));

    if (aktion === 'erstellt') {
      aenderungen = [{ feld: 'status', alt: null, neu: entry.newValues?.status }];
    } else if (aktion === 'statuswechsel' || aktion === 'zurueckgegeben') {
      aenderungen = aenderungen.filter((wert) => wert.feld === 'status');
    } else {
      aenderungen = aenderungen.filter((wert) => ['auto_id', 'kunde_id'].includes(wert.feld));
    }

    // Kein Feld geaendert, kein Eintrag: Eine Zeile ohne Feld und ohne Werte
    // behauptet eine Aenderung, die es nie gab. Der Endstand schreibt hier
    // ebenfalls nichts.
    if (aenderungen.length === 0) return;

    const insert = this.database.prepare(`INSERT INTO protokoll
                                          (tabelle, datensatz_id, aktion, feld, alter_wert, neuer_wert, account_id, zeitpunkt)
                                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const wert of aenderungen) {
      insert.run(
          'vermietungen',
          entry.resourceId,
          aktion,
          wert.feld,
          dbWert(wert.alt),
          dbWert(wert.neu),
          entry.actorId,
          entry.at ?? new Date().toISOString(),
      );
    }
  }

  list({ resource, resourceId, direction = 'asc' } = {}) {
    if (resource !== undefined && resource !== 'vermietung') return [];
    const where = resourceId === undefined ? '' : ' WHERE p.datensatz_id = ?';
    const values = resourceId === undefined ? [] : [resourceId];
    const order = String(direction).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    return this.database.prepare(`SELECT
                                    p.id, p.datensatz_id, p.aktion, p.feld, p.alter_wert,
                                    p.neuer_wert, p.account_id, p.zeitpunkt, a.name AS person
                                  FROM protokoll p
                                         JOIN account a ON a.id = p.account_id${where}
                                  ORDER BY p.id ${order}`).all(...values).map((row) => {
      const oldValue = auditWert(row.alter_wert);
      const newValue = auditWert(row.neuer_wert);
      return {
        id: row.id,
        at: row.zeitpunkt,
        actorId: row.account_id,
        action: `vermietung.${row.aktion}`,
        resource: 'vermietung',
        resourceId: row.datensatz_id,
        oldValues: row.feld ? { [row.feld]: oldValue } : undefined,
        newValues: row.feld ? { [row.feld]: newValue } : undefined,
        changes: row.feld ? [{ field: row.feld, oldValue, newValue }] : [],

        // Kompatibilitaet mit dem gelieferten Endstand-Frontend.
        zeitpunkt: row.zeitpunkt,
        person: row.person,
        aktion: row.aktion,
        feld: row.feld,
        alter_wert: row.alter_wert,
        neuer_wert: row.neuer_wert,
      };
    });
  }
}

class KompatiblerEventBus extends MemoryEventBus {
  async publish(event) {
    await super.publish(event);
    if (event?.topic === 'vermietung.changed') {
      await super.publish({ ...event, topic: 'vermietung-geaendert' });
    }
  }
}

function rolleDes(user) {
  return user?.role ?? user?.gruppe;
}

function darfWechseln(user, vermietung, ziel) {
  const rolle = rolleDes(user);
  if (!WECHSEL[vermietung.status]?.includes(ziel)) {
    throw new ConflictError(`Wechsel von ${vermietung.status} nach ${ziel} ist nicht erlaubt`);
  }
  if (ziel === 'storniert') {
    if (rolle !== 'admin') throw new ForbiddenError();
    if (Number(vermietung.erstelltVon) === Number(user.id)) {
      throw new ForbiddenError('Eigene Erfassungen duerfen nicht selbst storniert werden (Vier-Augen-Prinzip)');
    }
    return;
  }
  if (!['mitarbeiter', 'admin'].includes(rolle)) throw new ForbiddenError();
}

async function statusAendern({ input, repositories, user, transaction, emit }, ziel, audit) {
  const repo = repositories.vermietung;
  const aktuell = await repo.findById(input.id);
  if (!aktuell) throw new NotFoundError('Vermietung nicht gefunden');
  darfWechseln(user, aktuell, ziel);

  const werte = {
    status: ziel,
    geaendertAm: new Date().toISOString(),
    geaendertVon: user.id,
    version: aktuell.version,
    ...(ENDZUSTAENDE.has(ziel) ? { zurueckgegebenAm: new Date().toISOString() } : {}),
  };
  const ergebnis = await repo.updateWhere(input.id, werte, { status: aktuell.status });
  const auto = await repositories.auto.findById(aktuell.autoId);
  const neuesAuto = await repositories.auto.updateWhere(aktuell.autoId, { status: AUTOSTATUS[ziel] }, { status: auto.status });
  // Der Autostatus haengt am Vorgangsstatus. Die Autoliste anderer
  // Arbeitsplaetze soll das sofort sehen und nicht erst beim Polling.
  emit?.({
    topic: 'auto.changed',
    data: { operation: `statuswechsel:${ziel}`, resource: 'auto', value: neuesAuto ?? { ...auto, status: AUTOSTATUS[ziel] } },
  });
  await audit.write({
    at: new Date().toISOString(),
    actorId: user.id,
    action: ziel === 'abgeschlossen' ? 'zurueckgegeben' : `vermietung.transition:${ziel}`,
    resource: 'vermietung',
    resourceId: input.id,
    oldValues: aktuell,
    newValues: ergebnis,
    transaction,
  });
  return ergebnis;
}

function legacyVermietung(record) {
  if (!record || typeof record !== 'object') return record;
  return {
    ...record,
    auto_id: record.autoId,
    kunde_id: record.kundeId,
    account_id: record.accountId,
    ausgeliehen_am: record.ausgeliehenAm,
    zurueckgegeben_am: record.zurueckgegebenAm,
    erstellt_von: record.erstelltVon,
    geaendert_am: record.geaendertAm,
    geaendert_von: record.geaendertVon,
    gesperrt_von: record.gesperrtVon,
    gesperrt_am: record.gesperrtAm,
  };
}

// Der Endstand beantwortet veraendernde Aufrufe mit { ok: true } und
// POST /vermietungen mit { id }. Das Framework liefert stattdessen den
// vollstaendigen Datensatz. Wir senden beides: Der alte Client findet seine
// Felder (inklusive der Schreibweise mit Unterstrich), die generierte
// Oberflaeche behaelt Datensatz und version fuer die naechste Bearbeitung.
const LEGACY_OK_OPERATIONEN = new Set(['update', 'transition', 'lock.acquire', 'lock.release']);
const LEGACY_OK_ACTIONS = new Set(['statusKompatibel', 'rueckgabeKompatibel']);

function legacyAntwort({ kind, resource, operation, action, result }) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  if (kind === 'action') {
    if (action === 'vermieten') return legacyVermietung(result);
    return LEGACY_OK_ACTIONS.has(action) ? { ok: true, ...legacyVermietung(result) } : undefined;
  }
  if (resource !== 'vermietung' || !LEGACY_OK_OPERATIONEN.has(operation)) return undefined;
  return { ok: true, ...legacyVermietung(result) };
}

export function erstelleAutovermietungsConfig(database) {
  const audit = new ProtokollAuditAdapter(database);
  const events = new KompatiblerEventBus();

  return defineApp({
    name: 'autovermietung-modulendstand',
    database,
    audit,
    events,
    api: {
      prefix: '/api',
      eventsPath: '/ereignisse',
      response: legacyAntwort,
    },
    // Wie im Endstand: Ein getrennt laufendes Frontend (anderer Port) darf die
    // API ansprechen. Fuer den Betrieb ausserhalb der Schulung gehoert hier eine
    // konkrete Herkunft hin, z. B. { origin: 'https://vermietung.example' }.
    cors: true,
    ui: {
      generated: true,
      title: 'Autovermietung Flughafen',
      port: 5173,
    },
    migrations: {
      directory: fileURLToPath(new URL('./migrations-autovermietung', import.meta.url)),
    },
    documentation: {
      // Screenshots und Listen zeigen den aktuellen Datenbestand. Der Lauf
      // arbeitet auf einer Kopie von vermietung.db; die Datei selbst wird nur
      // gelesen. Mit 'fixtures' gelten stattdessen die Beispieldaten unten.
      data: 'live',
      title: 'Autovermietung Modulendstand',
      description: 'Mehrbenutzer-Autovermietung mit Transaktionen, Konfliktschutz, Rollen, Audit und Live-Updates.',
      author: 'M223',
      directory: fileURLToPath(new URL('./docs/generated', import.meta.url)),
      // Die Dokumentation arbeitet in einer isolierten Temp-Datenbank. Der
      // Admin steht absichtlich an erster Stelle: So sind die geschuetzte
      // Kontenliste und das Bearbeiten einer aktiven Vermietung fuer die
      // automatischen Screenshots sichtbar, ohne Produktivdaten anzufassen.
      fixtures: {
        account: [
          { benutzername: 'admin-doku', passwort: '1234', name: 'Admin Dokumentation', station: 'Zentrale', gruppe: 'admin' },
          { benutzername: 'hans-doku', passwort: '1234', name: 'Hans Dokumentation', station: 'Flughafen Schalter 1', gruppe: 'mitarbeiter' },
        ],
        kunde: [
          { vorname: 'Anna', nachname: 'Keller' },
          { vorname: 'Bruno', nachname: 'Steiner' },
        ],
        auto: [
          { marke: 'VW', modell: 'Golf', kennzeichen: 'ZH DOKU 001', status: 'vermietet' },
          { marke: 'Skoda', modell: 'Octavia', kennzeichen: 'ZH DOKU 002', status: 'frei' },
        ],
        vermietung: [{
          autoId: 1,
          kundeId: 1,
          accountId: 1,
          ausgeliehenAm: '2026-01-15T09:00:00.000Z',
          zurueckgegebenAm: null,
          status: 'aktiv',
          version: 1,
          erstelltVon: 1,
          geaendertAm: null,
          geaendertVon: null,
          gesperrtVon: null,
          gesperrtAm: null,
        }],
        protokoll: [{
          tabelle: 'vermietungen',
          datensatzId: 1,
          aktion: 'erstellt',
          // Ein Eintrag ohne Feld behauptet eine Aenderung, die niemand nachvollziehen
          // kann. Der Startbestand haelt sich an dieselbe Regel wie die Anwendung.
          feld: 'status',
          alterWert: null,
          neuerWert: 'aktiv',
          accountId: 1,
          zeitpunkt: '2026-01-15T09:00:00.000Z',
        }],
      },
    },
    // Die Szenarien stehen in jeder Konfiguration, nicht nur beim Testlauf:
    // `sichere-actions docs` traegt sie samt gespeichertem Ergebnis ins
    // Testprotokoll ein. `reset` und `createConfig` wirken ausschliesslich
    // waehrend `sichere-actions test` - dieser Lauf arbeitet in einer eigenen
    // temporaeren Datenbank.
    tests: {
      reset: true,
      output: fileURLToPath(new URL('./.sichere', import.meta.url)),
      createConfig: ({ database: testDatabase }) => erstelleAutovermietungsConfig(testDatabase),
      scenarios: fachlicheRegressionen,
    },
    auth: {
      resource: 'account',
      username: 'benutzername',
      password: 'passwort',
      role: 'gruppe',
      header: 'x-account-id',
      loginPath: '/login',
    },

    resources: {
      account: {
        table: 'account',
        path: '/accounts',
        label: 'Konto',
        pluralLabel: 'Kontenverwaltung',
        display: '{name}',
        operations: { list: true, get: true, create: true, update: true, delete: false },
        permissions: { read: ['admin'], create: ['admin'], update: ['admin'] },
        ui: { visibleFor: ['admin'], tableFields: ['benutzername', 'name', 'station', 'gruppe'] },
        fields: {
          benutzername: { type: 'string', required: true, unique: true, label: 'Benutzername' },
          // writeOnly: geht ins Formular hinein, kommt nie aus der API zurueck.
          passwort: { type: 'string', required: true, writeOnly: true, label: 'Passwort' },
          name: 'string!',
          station: 'string!',
          gruppe: { type: 'enum', values: ['mitarbeiter', 'admin'], required: true, label: 'Gruppe' },
        },
      },

      kunde: {
        table: 'kunden',
        path: '/kunden',
        label: 'Kunde',
        pluralLabel: 'Kunden',
        display: '{vorname} {nachname}',
        defaultSort: 'nachname',
        // Stammdaten duerfen gepflegt werden. Lesen bleibt offen wie im Endstand,
        // Aenderungen brauchen eine Rolle; Loeschen bleibt der Administration.
        operations: { list: true, get: true, create: true, update: true, delete: true },
        permissions: { create: ['mitarbeiter', 'admin'], update: ['mitarbeiter', 'admin'], delete: ['admin'] },
        ui: { tableFields: ['vorname', 'nachname'] },
        fields: {
          vorname: { type: 'string', required: true, label: 'Vorname' },
          nachname: { type: 'string', required: true, label: 'Nachname', sortable: true },
        },
      },

      auto: {
        table: 'autos',
        path: '/autos',
        label: 'Auto',
        pluralLabel: 'Autos',
        display: '{marke} {modell} ({kennzeichen})',
        // status bleibt schreibgeschuetzt: Ihn fuehrt der Vermietungsprozess.
        operations: { list: true, get: true, create: true, update: true, delete: true },
        permissions: { create: ['mitarbeiter', 'admin'], update: ['mitarbeiter', 'admin'], delete: ['admin'] },
        live: { mode: 'both', intervalMs: 30000 },
        ui: { tableFields: ['marke', 'modell', 'kennzeichen', 'status', 'frei'] },
        fields: {
          marke: 'string!',
          modell: 'string!',
          kennzeichen: { type: 'string', required: true, unique: true },
          status: {
            type: 'string',
            required: true,
            default: 'frei',
            readonly: true,
          },
        },
        computed: {
          frei: {
            field: { type: 'int', readonly: true, label: 'Frei' },
            compute: async ({ record, repositories }) => (
                await repositories.vermietung.exists({ autoId: record.id, zurueckgegebenAm: null }) ? 0 : 1
            ),
          },
        },
      },

      vermietung: {
        table: 'vermietungen',
        path: '/vermietungen',
        label: 'Vermietung',
        pluralLabel: 'Laufende Vorgaenge',
        display: '{autoId} - {kundeId}',
        defaultSort: 'id',
        defaultDirection: 'desc',
        // Der Endstand fuehrt den Autostatus redundant mit. Beim Wechsel des
        // Autos gilt: altes Auto frei, neues Auto uebernimmt den Vorgangsstatus
        // - beides in derselben Transaktion wie die Vermietung selbst.
        effects: {
          update: [
            {
              resource: 'auto', id: '$previous.autoId', values: { status: 'frei' },
              when: { ne: ['$previous.autoId', '$record.autoId'] },
            },
            {
              resource: 'auto', id: '$record.autoId',
              values: ({ record }) => ({ status: AUTOSTATUS[record.status] ?? 'frei' }),
              when: { ne: ['$previous.autoId', '$record.autoId'] },
            },
          ],
        },
        operations: { list: true, get: true, create: false, update: true, delete: false },
        permissions: { update: ['mitarbeiter', 'admin'] },
        policy: {
          default: 'deny',
          rules: [
            { action: 'read', effect: 'allow' },
            { action: 'update', roles: ['mitarbeiter'], states: ['offen', 'reserviert'], ownerField: 'erstelltVon' },
            { action: 'update', roles: ['admin'], states: ['offen', 'reserviert', 'aktiv'] },
            { action: 'transition:reserviert', roles: ['mitarbeiter', 'admin'], states: ['offen'] },
            { action: 'transition:aktiv', roles: ['mitarbeiter', 'admin'], states: ['reserviert'] },
            { action: 'transition:abgeschlossen', roles: ['mitarbeiter', 'admin'], states: ['aktiv'] },
            { action: 'transition:storniert', roles: ['admin'], states: ['offen', 'reserviert'], notOwnerField: 'erstelltVon' },
          ],
        },
        tracking: {
          createdAt: 'ausgeliehenAm',
          updatedAt: 'geaendertAm',
          createdBy: 'erstelltVon',
          updatedBy: 'geaendertVon',
          actorResource: 'account',
        },
        audit: true,
        live: { mode: 'both', intervalMs: 30000 },
        optimisticLock: { versionField: 'version' },
        editingLock: {
          expiresIn: '10m',
          actorField: 'gesperrtVon',
          atField: 'gesperrtAm',
          actorResource: 'account',
          actorDisplay: '{name}',
          roles: ['mitarbeiter', 'admin'],
          overrideRoles: ['admin'],
          acquireOverrideRoles: [],
          releaseOverrideRoles: ['admin'],
          acquirePath: '/sperren',
          releasePath: '/entsperren',
          acquireMethod: 'post',
          releaseMethod: 'post',
        },
        historyPath: '/verlauf',
        indexes: [
          {
            name: 'idx_auto_einmal_offen',
            fields: ['autoId'],
            unique: true,
            where: { zurueckgegebenAm: null },
          },
        ],
        ui: {
          tableFields: ['autoId', 'kundeId', 'mitarbeiter', 'status', 'ausgeliehenAm'],
        },
        fields: {
          autoId: {
            type: 'reference', target: 'auto', required: true, column: 'auto_id',
            label: 'Auto', display: '{marke} {modell} ({kennzeichen})',
          },
          kundeId: {
            type: 'reference', target: 'kunde', required: true, column: 'kunde_id',
            label: 'Kunde', display: '{vorname} {nachname}',
          },
          accountId: {
            type: 'reference', target: 'account', required: true, column: 'account_id',
            readonly: true, hidden: true,
          },
          ausgeliehenAm: {
            type: 'datetime', required: true, column: 'ausgeliehen_am', readonly: true,
            label: 'Ausgeliehen am',
          },
          zurueckgegebenAm: {
            type: 'datetime', optional: true, nullable: true, column: 'zurueckgegeben_am',
            readonly: true, hidden: true,
          },
          status: {
            type: 'enum', values: STATUS, default: 'offen', readonly: true, required: true,
          },
          version: { type: 'int', default: 1, readonly: true, required: true },
          erstelltVon: {
            type: 'reference', target: 'account', optional: true, nullable: true,
            column: 'erstellt_von', readonly: true, hidden: true,
          },
          geaendertAm: {
            type: 'datetime', optional: true, nullable: true,
            column: 'geaendert_am', readonly: true, hidden: true,
          },
          geaendertVon: {
            type: 'reference', target: 'account', optional: true, nullable: true,
            column: 'geaendert_von', readonly: true, hidden: true,
          },
          gesperrtVon: {
            type: 'reference', target: 'account', optional: true, nullable: true,
            column: 'gesperrt_von', readonly: true, hidden: true,
          },
          gesperrtAm: {
            type: 'datetime', optional: true, nullable: true,
            column: 'gesperrt_am', readonly: true, hidden: true,
          },
        },
        computed: {
          auto_id: verborgenesAlias('autoId', 'int'),
          kunde_id: verborgenesAlias('kundeId', 'int'),
          account_id: verborgenesAlias('accountId', 'int'),
          ausgeliehen_am: verborgenesAlias('ausgeliehenAm', 'datetime'),
          zurueckgegeben_am: verborgenesAlias('zurueckgegebenAm', 'datetime'),
          erstellt_von: verborgenesAlias('erstelltVon', 'int'),
          geaendert_am: verborgenesAlias('geaendertAm', 'datetime'),
          geaendert_von: verborgenesAlias('geaendertVon', 'int'),
          gesperrt_von: verborgenesAlias('gesperrtVon', 'int'),
          gesperrt_am: verborgenesAlias('gesperrtAm', 'datetime'),
          marke: nachschlagen('auto', 'autoId', 'marke', { hidden: true }),
          modell: nachschlagen('auto', 'autoId', 'modell', { hidden: true }),
          kennzeichen: nachschlagen('auto', 'autoId', 'kennzeichen', { hidden: true }),
          vorname: nachschlagen('kunde', 'kundeId', 'vorname', { hidden: true }),
          nachname: nachschlagen('kunde', 'kundeId', 'nachname', { hidden: true }),
          mitarbeiter: nachschlagen('account', 'accountId', 'name', { label: 'Mitarbeiter' }),
          station: nachschlagen('account', 'accountId', 'station', { hidden: true }),
          gesperrtVonName: nachschlagen('account', 'gesperrtVon', 'name', { hidden: true }),
          gesperrt_von_name: nachschlagen('account', 'gesperrtVon', 'name', { hidden: true }),
          geaendert_von_name: nachschlagen('account', 'geaendertVon', 'name', { hidden: true }),
        },
        workflow: {
          field: 'status',
          initial: 'offen',
          endpoint: {
            path: '/workflow-status',
            method: 'post',
            field: 'status',
            exclusive: true,
          },
          transitions: {
            reserviert: {
              from: 'offen', to: 'reserviert', label: 'Reservieren',
              roles: ['mitarbeiter', 'admin'],
              effects: [{ resource: 'auto', id: '$resource.autoId', values: { status: 'reserviert' } }],
            },
            aktiv: {
              from: 'reserviert', to: 'aktiv', label: 'Herausgeben',
              roles: ['mitarbeiter', 'admin'],
              effects: [{ resource: 'auto', id: '$resource.autoId', values: { status: 'vermietet' } }],
            },
            abgeschlossen: {
              from: 'aktiv', to: 'abgeschlossen', label: 'Zurueckgeben',
              roles: ['mitarbeiter', 'admin'],
              values: () => ({ zurueckgegebenAm: new Date().toISOString() }),
              effects: [{ resource: 'auto', id: '$resource.autoId', values: { status: 'frei' } }],
            },
            storniert: {
              from: ['offen', 'reserviert'], to: 'storniert', label: 'Stornieren',
              roles: ['admin'],
              authorize: ({ user, resource }) => Number(resource.erstelltVon) !== Number(user.id),
              values: () => ({ zurueckgegebenAm: new Date().toISOString() }),
              effects: [{ resource: 'auto', id: '$resource.autoId', values: { status: 'frei' } }],
            },
          },
        },
      },

      protokoll: {
        table: 'protokoll',
        label: 'Protokolleintrag',
        pluralLabel: 'Protokoll',
        operations: { list: false, get: false, create: false, update: false, delete: false },
        ui: { hidden: true },
        documentation: { hidden: true },
        fields: {
          tabelle: 'string!',
          datensatzId: { type: 'int', required: true, column: 'datensatz_id' },
          aktion: 'string!',
          feld: { type: 'string', optional: true, nullable: true },
          alterWert: { type: 'string', optional: true, nullable: true, column: 'alter_wert' },
          neuerWert: { type: 'string', optional: true, nullable: true, column: 'neuer_wert' },
          accountId: { type: 'reference', target: 'account', required: true, column: 'account_id' },
          zeitpunkt: 'datetime!',
        },
      },
    },

    actions: {
      vermieten: ({ resources }) => ({
        path: '/vermietungen',
        method: 'post',
        roles: ['mitarbeiter', 'admin'],
        successStatus: 201,
        transaction: true,
        input: {
          autoId: {
            type: 'reference', target: 'auto', required: true, lock: true,
            label: 'Auto', display: '{marke} {modell} ({kennzeichen})', where: { frei: 1 },
          },
          kundeId: {
            type: 'reference', target: 'kunde', required: true,
            label: 'Kunde', display: '{vorname} {nachname}',
          },
          sofort: {
            type: 'boolean', default: true,
            label: 'Sofort herausgeben',
            description: 'Deaktiviert bedeutet: nur reservieren.',
          },
        },
        require: [
          notExists({
            resource: resources.vermietung,
            where: ({ autoId }) => ({ autoId, zurueckgegebenAm: null }),
            error: conflict('Dieses Auto ist bereits vermietet', { code: 'AUTO_BELEGT' }),
          }),
        ],
        create: {
          resource: resources.vermietung,
          values: ({ input, user }) => ({
            autoId: input.autoId,
            kundeId: input.kundeId,
            accountId: user.id,
            zurueckgegebenAm: null,
            status: input.sofort === false ? 'reserviert' : 'aktiv',
          }),
        },
        effects: [
          {
            resource: resources.auto,
            id: '$input.autoId',
            values: ({ input }) => ({ status: input.sofort === false ? 'reserviert' : 'vermietet' }),
          },
        ],
        audit: { action: 'erstellt' },
        publish: ({ result }) => ({
          topic: 'vermietung.changed',
          data: { operation: 'create', resource: 'vermietung', value: result },
        }),
        documentation: {
          label: 'Neue Vermietung',
          summary: 'Auto vermieten oder reservieren',
          description: 'Ein freies Auto wird transaktional vermietet oder reserviert.',
          successMessage: 'Vermietung erfasst.',
        },
      }),

      statusKompatibel: {
        path: '/vermietungen/:id/status',
        method: 'post',
        roles: ['mitarbeiter', 'admin'],
        transaction: true,
        input: {
          id: { type: 'int', required: true, source: param('id'), hidden: true },
          status: { type: 'enum', values: STATUS, required: true },
        },
        execute: (context) => statusAendern(context, context.input.status, audit),
        publish: ({ result }) => ({
          topic: 'vermietung.changed',
          data: { operation: 'statuswechsel', resource: 'vermietung', value: result },
        }),
        documentation: { hidden: true, summary: 'Kompatibler Statusendpunkt' },
      },

      rueckgabeKompatibel: {
        path: '/vermietungen/:id/rueckgabe',
        method: 'post',
        roles: ['mitarbeiter', 'admin'],
        transaction: true,
        input: {
          id: { type: 'int', required: true, source: param('id'), hidden: true },
        },
        execute: (context) => statusAendern(context, 'abgeschlossen', audit),
        publish: ({ result }) => ({
          topic: 'vermietung.changed',
          data: { operation: 'zurueckgegeben', resource: 'vermietung', value: result },
        }),
        documentation: { hidden: true, summary: 'Kompatibler Rueckgabeendpunkt' },
      },
    },

    configure({ app }) {
      // Das Endstand-Frontend erwartet die alten Felder `fehler` und `details`.
      // Die Framework-Felder bleiben parallel erhalten, damit die generierte UI
      // und externe Clients weiterhin den stabilen Fehlercode verwenden koennen.
      app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        // Unbekannte Fehler duerfen nichts ueber ihr Innenleben verraten. Der
        // Text ist derselbe wie im Endstand, damit auch ein 500 als `fehler`
        // ankommt und nicht als "Unbekannter Fehler" im Frontend landet.
        if (!(error instanceof HttpError)) {
          console.error(error);
          return res.status(500).json({
            fehler: 'Interner Serverfehler',
            code: 'INTERNAL_ERROR',
            message: 'Interner Serverfehler',
            error: { code: 'INTERNAL_ERROR', message: 'Interner Serverfehler' },
          });
        }
        const original = error.details ?? {};
        let details = original;

        if (error.status === 409 && /Eindeutiger Wert bereits vorhanden/i.test(error.message)) {
        // Der partielle UNIQUE-Index laesst nur eine offene Vermietung je Auto
        // zu. Der Endstand nennt diesen Fall AUTO_BELEGT.
        return res.status(409).json({
          fehler: 'Dieses Auto ist bereits vermietet',
          details: { code: 'AUTO_BELEGT' },
          code: 'CONFLICT',
          message: 'Dieses Auto ist bereits vermietet',
          error: { code: 'CONFLICT', message: 'Dieses Auto ist bereits vermietet', details: { code: 'AUTO_BELEGT' } },
          conflict: { code: 'AUTO_BELEGT' },
        });
      }
      if (error.status === 409 && (original.currentData || original.current)) {
          const aktuell = legacyVermietung(original.currentData ?? original.current);
          details = {
            ...original,
            code: 'VERSIONSKONFLIKT',
            aktuelleVersion: original.currentVersion ?? aktuell.version,
            geaendertAm: original.changedAt ?? aktuell.geaendert_am,
            geaendertVon: original.changedByName ?? original.changedByActor?.name,
            aktuelleDaten: aktuell,
          };
        } else if (error.status === 423) {
          const rest = Math.max(0, Date.parse(original.expiresAt) - Date.now());
          details = {
            ...original,
            code: 'GESPERRT',
            gesperrtVon: original.actorName ?? original.actor?.name ?? original.ownerId,
            gesperrtAm: original.lockedAt,
            gueltigNochMinuten: Math.round(rest / 60000),
          };
        }

        res.status(error.status).json({
          fehler: error.message,
          details,
          code: error.code,
          message: error.message,
          error: { code: error.code, message: error.message, details },
          ...(error.status === 409 ? { conflict: details } : {}),
        });
      });
    },

    seed: {
      account: [
        { benutzername: 'hans', passwort: '1234', name: 'Hans Meier', station: 'Flughafen Schalter 1', gruppe: 'mitarbeiter' },
        { benutzername: 'paul', passwort: '1234', name: 'Paul Weber', station: 'Flughafen Schalter 2', gruppe: 'mitarbeiter' },
        { benutzername: 'admin', passwort: '1234', name: 'Admin Person', station: 'Zentrale', gruppe: 'admin' },
      ],
      kunde: [
        { vorname: 'Anna', nachname: 'Keller' },
        { vorname: 'Bruno', nachname: 'Steiner' },
        { vorname: 'Carla', nachname: 'Frei' },
      ],
      auto: [
        { marke: 'VW', modell: 'Golf', kennzeichen: 'ZH 100 001', status: 'vermietet' },
        { marke: 'Skoda', modell: 'Octavia', kennzeichen: 'ZH 100 002', status: 'frei' },
        { marke: 'Fiat', modell: 'Panda', kennzeichen: 'ZH 100 003', status: 'frei' },
      ],
      vermietung: () => [{
        autoId: 1,
        kundeId: 1,
        accountId: 1,
        ausgeliehenAm: new Date().toISOString(),
        zurueckgegebenAm: null,
        status: 'aktiv',
        version: 1,
        erstelltVon: 1,
        geaendertAm: null,
        geaendertVon: null,
        gesperrtVon: null,
        gesperrtAm: null,
      }],
      protokoll: () => [{
        tabelle: 'vermietungen',
        datensatzId: 1,
        aktion: 'erstellt',
        feld: 'status',
        alterWert: null,
        neuerWert: 'aktiv',
        accountId: 1,
        zeitpunkt: new Date().toISOString(),
      }],
    },
  });
}

export default ({ database } = {}) => erstelleAutovermietungsConfig(
    database ?? sqlite(PRODUKTIONS_DATENBANK, { journalMode: 'WAL', busyTimeout: 5000 }),
);