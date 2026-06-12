# agor 🕵️

**Robotul tău neobosit de vânătoare de chilipiruri pe piețele online.**

*Citește în altă limbă: [English](./README.md) · [Română](./README.ro.md)*

Știi ritualul: dai refresh la un site de anunțuri, încă o dată, verifici alt
site, *poate* arunci o privire pe al treilea, ratezi chilipirul cu 20 de minute,
și-l vezi repostat a doua zi cu 800 € mai scump. agor pune capăt ritualului.
Lipești un link de căutare în Telegram, apeși **▶️ Pornește**, și îți vezi de
viață — botul urmărește piața și te anunță în clipa în care se întâmplă ceva.

agor este **agnostic față de piață**. Motorul are **zero cod specific fiecărui
site** — fiecare piață este un fișier YAML declarativ în `plugins/`, așa că
integrarea unui site nou (orice țară, orice categorie) înseamnă scrierea unui
manifest, nu modificarea motorului. Vine cu unsprezece piețe integrate (sunt
românești pentru că de acolo a pornit totul). **[Adaugă-l pe al tău →](./docs/ONBOARDING.md)**

## Ce prinde

- 🆕 **Anunțuri noi** pe orice căutare salvată — diferență de mulțime față de tot
  ce a văzut deja, deci ești notificat doar pentru anunțuri *cu adevărat* noi
- 📉 **Scăderi de preț** la un anunț urmărit (cu economia detaliată)
- 🟢 **Revenit în stoc** — produsele ieșite din stoc sunt verificate pe un tier
  *mai rapid*, fiindcă reaprovizionările nu așteaptă programări politicoase
- 🔥 **Etichete de ofertă** — fiecare alertă e raportată la mediana pieței
  (per monedă): `🔥 chilipir`, `📊 preț corect` sau `📈 supraevaluat`
- 👯 **Comasarea anunțurilor duplicate** — aceeași mașină postată pe două site-uri
  devine O SINGURĂ alertă cu o linie „Și pe:", nu două notificări la 7 dimineața
- 🚫 **Filtre** — vânzători privați vs. dealeri, cuvinte excluse
  (`lovit, piese, dube` — dispărute), frecvență de verificare per urmărire
- 📊 **Grafice de istoric al prețului** randate ca PNG-uri, la o atingere distanță
- ✍️ **Schițe de ofertă** — un mesaj de negociere copy-paste ancorat la −10%,
  rotunjit la o cifră suspect de umană
- ⚠️ **Notificări de sănătate** — dacă o urmărire e blocată sau amuțește, botul
  *îți spune* în loc să tacă bosumflat

## Adaugă o piață

**Orice piață poate fi integrată punând un manifest YAML în `plugins/` — fără
modificări ale motorului, fără redeploy de logică.** Un manifest declară *unde
se află datele* și *ce câmp se mapează la ce*; motorul generic face restul. Site
nou = YAML nou; redesign de site = editezi acel YAML.

Motorul vorbește patru dialecte generice de „unde ai ascuns datele", iar un
manifest doar alege unul:

- `script#__NEXT_DATA__` / `window.*` — JSON de stare încorporat (inclusiv blob-uri
  `window.*` dublu-codate)
- `ldjson` — blocuri schema.org, tolerante la JSON *formatat creativ*
- `flight:<anchor>` — fluxuri RSC Next.js (chunk-uri `self.__next_f`, decodate și
  feliate echilibrat)
- `dom-selector` — selectoare CSS simple pentru HTML randat pe server

**→ Ghid complet: [docs/ONBOARDING.md](./docs/ONBOARDING.md)** — alege un dialect,
găsește payload-ul, mapează câmpurile și verifică cu un test local.

## Limbi

Interfața botului este complet localizată; alege-o cu `/lang <cod>`. Disponibile azi:

| Cod | Limbă | README |
|---|---|---|
| `en` | English (implicit) | [README.md](./README.md) |
| `ro` | Română | [README.ro.md](./README.ro.md) |

Fiecare text afișat utilizatorului trăiește într-un singur catalog tipizat
(`src/gateway/strings.ts`), iar sistemul de tipuri transformă o traducere lipsă
într-o eroare de *compilare* — deci adăugarea unei limbi e mecanică și nu poate
fi livrată pe jumătate. Preferința per chat este reținută; chat-urile noi
folosesc implicit engleza.

Comenzi: `/track <url>` (sau lipește direct un link), `/list`, `/check <id>`,
`/remove <id>`, `/lang`, `/request-access`, `/help`.

## Cine are acces

Botul este **interzis-implicit**. Un utilizator nou poate doar `/start` și
`/request-access` — care cere un nume și un email, apoi anunță administratorii
(care aprobă sau resping cu o atingere). **Prima persoană care finalizează
`/request-access` devine administrator** automat, deci nu există problema oului
și a găinii; alternativ, poți semăna id-uri de chat administrator prin
`ADMIN_CHAT_IDS`. Administratorii gestionează totul din propriul chat:
`/allow <id>`, `/deny <id>`, `/users`, `/userinfo <id>`, `/setname <id> <nume>`,
`/setemail <id> <email>`, plus `/promote <id>` / `/demote <id>` pentru a numi sau
retrage alți administratori (ultimul administrator nu poate fi retras). Un
utilizator respins poate cere din nou după 7 zile; retragerea unui utilizator îi
pune urmăririle pe pauză (re-permiterea le reia). Numele/emailul sunt doar pentru
evidență — trăiesc în baza de date (ca să știi cui aparține un chat), niciodată
în loguri.

## Pornește-l

```bash
npm ci
cp .env.example .env       # adaugă BOT_TOKEN de la @BotFather
npm test                   # 300+ teste, toate verzi sau îți dau banii înapoi
npm start                  # long-polling — merge de pe orice laptop, din spatele oricărui NAT
```

Fără token? Tot pornește în mod headless (scheduler-ul rulează, nu se livrează
nimic) — util pentru CI și experimentat.

### Producție

Trăiește fericit pe un **Raspberry Pi sub PM2**, opțional cu **webhook-uri
printr-un Cloudflare Tunnel** și **loguri structurate trimise către Grafana
Cloud** (un eveniment JSON per verificare — „a verificat corect de fiecare dată?"
e un panou de dashboard, nu un mister). Runbook-ul complet de la zero, inclusiv
capcanele ARM și un dashboard Grafana gata făcut (`grafana/agor-logs.json`), e în
**[DEPLOYMENT.md](./DEPLOYMENT.md)**.

## Sub capotă

Node 20 (ESM) · TypeScript · [grammY](https://grammy.dev) · better-sqlite3 ·
undici · @napi-rs/canvas · pino (→ Loki) · vitest.

Etichetă anti-bot: anteturi care imită browserul (UA desktop-Chrome rotit cu
Client Hints + `Sec-Fetch-*` și un `Accept-Language` per magazin), **urmărirea
redirecturilor** (un 301 `www→apex` nu mai produce în tăcere zero rezultate),
limite de rată per vendor, pool de proxy rotativ cu bench-and-retry la 429/403,
și extracție *soft-fail* — un redesign de site degradează într-un ciclu gol și o
notificare politicoasă de sănătate, niciodată într-o buclă de crash.

Fetch conștient de blocaje: un zid anti-bot recunoscut e detectat din **anteturile
răspunsului** (semnături Akamai/Cloudflare/Imperva/Fastly/CloudFront + un status
de refuz — niciodată un grep pe body, care ar da fals-pozitiv la SDK-urile
anti-bot pe care orice pagină funcțională le încorporează). Un vendor care rămâne
blocat sau eșuează declanșează un **circuit breaker per vendor**, ca un domeniu
mort să nu fie lovit la fiecare ciclu. Manifestele pot opta pentru un **fallback
cu browser headless** (`fetch_strategy: browser`, Playwright + stealth încărcate
leneș) pentru vendori cu conținut prin JS sau cu fingerprinting (ex. mobile.de) —
oprit implicit (`ENABLE_BROWSER_FALLBACK`), deci instalarea de bază pe Raspberry
Pi nu are nevoie de Chromium. Urmăririle noi sunt validate la înregistrare: un URL
mort/4xx e respins din start, iar URL-ul canonic de după redirect e persistat.

Arhitectura e specificată complet: fiecare comportament trăiește în
`openspec/specs/`, iar fiecare schimbare trece printr-un ciclu
[OpenSpec](https://github.com/Fission-AI/OpenSpec) propune → implementează →
arhivează (`openspec/changes/`). Da, până și acest README a avut funcționalitățile
specificate mai întâi. 📋

## Piețe integrate

Unsprezece livrate azi (toate românești — prima piață spre care a fost îndreptat).
Adăugarea altora din orice țară e la distanță de un manifest ([ghid](./docs/ONBOARDING.md)).

| Mașini | Imobiliare | General / altele |
|---|---|---|
| OLX.ro | Storia.ro | Lajumate.ro |
| Autovit.ro | Imobiliare.ro | Publi24.ro |
| Carzz.ro | Imoradar24.ro | Vinted.ro |
| mobile.de (RO) | Homezz.ro | |

## Licență

[MIT](./LICENSE) © Valentin Mosor — ia-l, fork-uiește-l, livrează-l; doar
păstrează linia de copyright. Vânătoare plăcută. 🏁
