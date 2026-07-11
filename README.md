# One World Click

Echte Mehrspieler-Klick-App mit React, Socket.io und PostgreSQL. Der Server zaehlt ausschliesslich Klicks von verbundenen Nutzern.

## Lokal testen

1. PostgreSQL starten und eine Datenbank anlegen.
2. Im Projekt eine Datei `.env` anlegen: `DATABASE_URL=postgresql://USER:PASSWORT@localhost:5432/oneworldclick`
3. `npm install` ausfuehren.
4. In einem Terminal `npm run server` und in einem zweiten `npm run dev` starten.

## Oeffentlich bereitstellen mit Render

1. Projekt in ein GitHub-Repository hochladen.
2. Bei Render zuerst **New > PostgreSQL** erstellen.
3. Danach **New > Web Service** erstellen und das GitHub-Repository auswaehlen.
4. Build Command: `npm install && npm run build`
5. Start Command: `npm start`
6. In **Environment** eine Variable `DATABASE_URL` anlegen. Als Wert die **Internal Database URL** der gerade erstellten PostgreSQL-Datenbank einfuegen.
7. Deploy starten. Die Render-Adresse kann auf jedem Geraet geoeffnet und zum Home-Bildschirm hinzugefuegt werden.

Die Tabellen werden beim ersten Start automatisch angelegt. Die Daten liegen danach in PostgreSQL, nicht mehr in einer lokalen JSON-Datei.
