# VLOG SOAP Print Mock

TypeScript/Bun-Mock für `POST /WorkflowInterface`. Der Server simuliert VLOG-Druckantworten und prüft SOAP sowie das eingebettete Workitem-XML. Er verbindet sich weder mit VLOG noch mit DHL oder einem Drucker.

## Docker Compose

```sh
docker compose up -d
```

Endpoint: `http://localhost:18080/WorkflowInterface`. Anderen Host-Port wählen:

```sh
VLOG_PORT=18081 docker compose up -d
```

Compose baut das Image beim ersten Start. Nach Quellcodeänderungen mit `docker compose up -d --build` neu bauen. Logs: `docker compose logs -f`. Stoppen und Container entfernen: `docker compose down`.

Die CLI gibt pro Call Methode, Pfad, Content-Type, SOAPAction und den vollständigen Request-Body aus. Danach folgt `Call Successful` oder `Call Failed: <Fehlermeldung>`. Fachliche VLOG-Fehler werden auch bei HTTP 200 als fehlgeschlagen ausgegeben. Die vollständige Response-XML wird nur an den Client gesendet.

## Lokal mit Bun

```sh
bun install --frozen-lockfile
bun start
```

Endpoint: `http://127.0.0.1:8080/WorkflowInterface`. Bind-Adresse und Port lassen sich mit `HOST` und `PORT` überschreiben:

```sh
HOST=0.0.0.0 PORT=18080 bun start
```

Beispielaufruf gegen Docker Compose:

```sh
curl --data-binary @fixtures/request.xml \
  -H 'Content-Type: text/xml; charset=utf-8' \
  -H 'SOAPAction: http://mhp-net.de/services/workflowexecutor/Executor/Execute' \
  http://localhost:18080/WorkflowInterface
```

## Docker ohne Compose

```sh
docker build -t vlog-soap-mock-server .
docker run --rm --name vlog-mock -p 18080:8080 vlog-soap-mock-server
```

Das Image enthält nur Laufzeitabhängigkeiten, Quellcode und Fixtures. Der Prozess läuft als Benutzer `bun` auf `0.0.0.0:8080`; Volumes sind nicht erforderlich. `HOST` und `PORT` lassen sich mit `-e` überschreiben. Bei geändertem Container-Port das Portmapping anpassen.

## Prüfregeln

- Äußere SOAP-XML und eingebettetes Workitem müssen wohlgeformt sein. DTDs sind deaktiviert. Grenzen: 1 MiB Requestgröße und 64 Ebenen XML-Verschachtelung.
- SOAP 1.1: `http://schemas.xmlsoap.org/soap/envelope/`; Execute, command und serializedWorkItem: `http://mhp-net.de/services/workflowexecutor`. Namespace-Präfixe sind frei wählbar.
- Workitem-Elemente haben keinen Namespace. Genau eine Sendung mit genau einem Paket wird unterstützt. Doppelte Feldnamen einschließlich Varianten der Groß-/Kleinschreibung werden abgelehnt.
- Content-Type darf fehlen. Falls vorhanden: `text/xml`, optional `charset=utf-8`. Bytes und vorhandene XML-Encodingdeklarationen müssen UTF-8 sein.
- SOAPAction: `http://mhp-net.de/services/workflowexecutor/Executor/Execute`, optional in doppelten Anführungszeichen.
- command: `Label:Print` oder `Label:Retry`.
- Send_Mandant: `701`; Int_Arbeitsplatz: nicht leer; Frachtfuehrer: `DHL`.
- Send_2N_ProdCode: `PRIO` oder `STD`.
- Send_GewichtEinzel: Zahl mit Komma als Dezimaltrennzeichen, beispielsweise `2,32`; Wertebereich 0,01–31,5 kg.
- Zusätzliche XML-Felder sind zulässig, beispielsweise Empf_Fax und Send_NachnahmeBetrag. Sie werden mit kleingeschriebenen Elementnamen zurückgegeben. Namespace-Deklarationen für Attribute bleiben erhalten.

## Antworten

Erfolg und fachliche Fehler verwenden HTTP 200 mit `ExecuteResponse/ExecuteResult/a:string`. Der String enthält das escapete Workitem-XML. Clients müssen dessen Fehlerstatus bzw. `mhp/error` prüfen.

Erfolg: shipment_status 800, package_status 899. Fachliche Fehler verwenden je nach Fehlerklasse Sendungs-/Paketfehler oder `mhp/error`. Ungültiges SOAP/XML und falsche SOAPAction erzeugen HTTP 500 mit SOAP Fault; falscher Content-Type bzw. Zeichensatz erzeugt HTTP 415 mit leerem Body.

SOAP-Antworten, Faults und eingebettetes Workitem-XML werden lesbar mit zwei Leerzeichen eingerückt. Der gesendete Befehl bleibt erhalten. Erfolgreiche Drucksimulationen werden asynchron um **2 Sekunden**, Fehler einschließlich fachlicher Fehler mit HTTP 200 um **500 ms** verzögert.

IDs und Prozesszeitstempel werden simuliert. Sendungsnummern beginnen mit `MOCK-` und sind keine DHL-Sendungsnummern. Auftragsreferenzen bleiben unverändert. Die enthaltenen Beispieldaten sind synthetisch.

## Grenzen

Die Antwortvorlagen bilden eine einzelne DHL-Weltpaket-Beispielsendung mit Empfängerland ES ab. STD und PRIO verwenden darin Produkt 18 / DPA. Weitere Länder, Zusatzleistungen, abgeleitete Adress-/Routingfelder und Nachnahme-Workflows werden nicht vollständig berechnet. Label:Retry verwendet dieselbe Simulation ohne persistente Sendungshistorie. WSDL und mehrere Sendungen/Pakete werden nicht unterstützt.

Die Validierung ist beim leeren Arbeitsplatz und beim Punkt als Dezimaltrennzeichen bewusst strenger als das beobachtete VLOG-Verhalten. Solche Formatfehler erhalten eigene MOCK-Meldungen. Nicht untersuchte Werte verwenden die Fehlerklasse der jeweiligen Vorlage; exakte VLOG-Meldungen für jede Konfiguration werden nicht garantiert.

XML wird mit [saxes](https://github.com/lddubeau/saxes) geprüft. Das Upstream-Repository ist archiviert; externe Entitäten und DTDs werden nicht geladen.

## Tests

```sh
bun test
bun run typecheck
```

## Git-Dateiauswahl

Die `.gitignore` erlaubt ausschließlich die aufgeführten Anwendungs-, Test-, Fixture- und Bereitstellungsdateien sowie diese Anleitung. Neue Dateien müssen ausdrücklich in die Allowlist aufgenommen werden. Interne Dokumentation, KI-Anweisungen, lokale Originaldaten, Umgebungsdateien und Entwicklungswerkzeuge bleiben ausgeschlossen. Auch in freigegebenen Dateien dürfen keine vertraulichen Inhalte ergänzt werden.
