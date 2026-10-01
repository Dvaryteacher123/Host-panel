# WhatsApp Groups Shop — Full-Stack (Node.js + Express + Firebase + HarakaPay)

Mfumo kamili wa kuuza link za WhatsApp Groups. Malipo kupitia **HarakaPay USSD Push**,
data kwenye **Firebase Firestore**, watumiaji kupitia **Firebase Authentication**,
backend kwenye **Render**.

---

## 1. MUUNDO WA PROJECT

```
/
├── public/
│   ├── index.html          -> website ya wateja (mobile-app style)
│   ├── admin.html          -> admin dashboard
│   ├── style.css           -> theme ya premium dark/glass
│   ├── app.js               -> logic ya frontend ya wateja
│   ├── admin.js             -> logic ya admin dashboard
│   └── firebase-config.js   -> Firebase client config (SI siri)
├── server.js                -> backend (Express) - HUKU ndiko HARAKAPAY_API_KEY ipo
├── package.json
├── .env.example
├── firestore.rules          -> Firestore Security Rules
└── README.md
```

**Muhimu**: `HARAKAPAY_API_KEY` HAIPO popote kwenye `public/` — ipo tu
kwenye `server.js` kupitia `process.env.HARAKAPAY_API_KEY`.

---

## 2. JINSI MFUMO UNAVYOFANYA KAZI (MTIRIRIKO)

```
Mteja anabofya "PAY NOW"
        |
        v
Frontend (index.html) --POST--> /api/payment/create  [Backend Render]
        |
        v
Backend inaita HarakaPay: POST https://harakapay.net/api/v1/collect
        |
        v
HarakaPay inatuma USSD Push kwa simu ya mteja
        |
        v
Mteja anathibitisha kwenye simu yake
        |
        v
HarakaPay --POST--> /api/harakapay/webhook  [Backend Render]  (au)
Backend --GET--> https://harakapay.net/api/v1/status/{order_id}  (backup)
        |
        v
Backend inasasisha Firestore: paymentStatus = "paid", groupLink imewekwa
        |
        v
Frontend inapoll: GET /api/payment/status/:orderId  [Backend Render, SI HarakaPay moja kwa moja]
        |
        v
Mteja anaona "PAYMENT SUCCESSFUL" na button "OPEN WHATSAPP GROUP"
```

---

## 3. VITU UNAVYOHITAJI KUWEKA (HATUA KWA HATUA)

### 3.1 Firebase Project

1. Nenda [console.firebase.google.com](https://console.firebase.google.com) -> Create Project.
2. **Authentication** -> Sign-in method -> washa **Email/Password**.
3. **Firestore Database** -> Create database (production mode).
4. Kwenye **Firestore Rules**, bandika content ya faili `firestore.rules` iliyopo hapa
   (Firebase Console -> Firestore Database -> Rules -> paste -> Publish).
5. Nenda **Project Settings -> General -> Your apps** -> bofya `</>` (Web app) -> sajili app
   -> utapata `firebaseConfig` object.
6. **Fungua `public/firebase-config.js`** kwenye project hii, na **badilisha** sehemu hii:
   ```js
   const firebaseConfig = {
     apiKey: "WEKA_FIREBASE_API_KEY",
     authDomain: "WEKA_PROJECT_ID.firebaseapp.com",
     projectId: "WEKA_PROJECT_ID",
     storageBucket: "WEKA_PROJECT_ID.appspot.com",
     messagingSenderId: "WEKA_MESSAGING_SENDER_ID",
     appId: "WEKA_APP_ID",
   };
   ```
   Weka values halisi kutoka Firebase Console. **Hizi SI siri** — ni config ya kawaida
   ya Firebase Web App, ulinzi wa kweli upo kwenye Firestore Rules.

7. Kwenye faili ile ile, badilisha:
   ```js
   export const API_BASE_URL = "https://WEKA-RENDER-DOMAIN-YAKO.onrender.com";
   ```
   kuwa URL halisi ya backend yako baada ya ku-deploy Render (hatua 4).

### 3.2 Firebase Admin SDK (kwa Backend)

1. Firebase Console -> Project Settings -> **Service Accounts** -> "Generate new private key".
2. Utapakua faili la JSON lenye: `project_id`, `client_email`, `private_key`.
3. Hizi 3 thamani ndizo utaweka kwenye **Render Environment Variables** (si kwenye code):
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_CLIENT_EMAIL`
   - `FIREBASE_PRIVATE_KEY` (bandika yote pamoja na `-----BEGIN PRIVATE KEY-----`)

### 3.3 Tengeneza Admin wa Kwanza

Baada ya kujisajili mara moja kupitia `index.html` (au moja kwa moja Firebase Console ->
Authentication -> Add user), nenda **Firestore Database -> admins collection** -> **Add document**:

- Document ID: **UID ya mtumiaji huyo** (pata kwenye Authentication tab)
- Field: `email` = barua pepe yake

Sasa mtumiaji huyo anaweza ku-login kwenye `admin.html`.

---

## 4. KUDEPLOY RENDER (BACKEND)

1. Piga `git init`, `git add .`, `git commit -m "init"`, kisha tengeneza repo GitHub na
   `git push` project hii yote (backend + public/ folder pamoja).
2. Nenda [render.com](https://render.com) -> **New -> Web Service**.
3. Unganisha GitHub repo yako.
4. Weka:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: Node
5. Kwenye tab ya **Environment**, ongeza Environment Variables zifuatazo:

   | Key | Value |
   |---|---|
   | `HARAKAPAY_API_KEY` | api key yako halisi ya HarakaPay |
   | `HARAKAPAY_BASE_URL` | `https://harakapay.net` |
   | `APP_BASE_URL` | URL ya Render itakayopewa baada ya deploy, mfano `https://whatsapp-shop.onrender.com` |
   | `FIREBASE_PROJECT_ID` | kutoka service account JSON |
   | `FIREBASE_CLIENT_EMAIL` | kutoka service account JSON |
   | `FIREBASE_PRIVATE_KEY` | kutoka service account JSON (na `\n` ndani ya quotes) |

6. Bofya **Create Web Service**. Render itatoa URL kama `https://whatsapp-shop-xxxx.onrender.com`.
7. **Rudi kwenye `.env` ya Render** na hakikisha `APP_BASE_URL` inalingana na URL hiyo halisi
   (bila `/` mwishoni). Hii ndiyo itakayotumika kwenye `webhook_url` unapotuma request HarakaPay.
8. **Rudi kwenye `public/firebase-config.js`**, weka `API_BASE_URL` iwe URL hiyo hiyo ya Render,
   kisha `git push` tena ili Render ipate update.

> Render "Free" instance inaweza "kulala" ikiwa haitumiki kwa muda — request ya kwanza baada
> ya kulala inaweza kuchukua sekunde chache zaidi. Hii ni tabia ya kawaida ya Render free tier.

---

## 5. WEBHOOK URL

Baada ya deploy, webhook URL yako itakuwa:

```
https://WEKA-RENDER-DOMAIN-YAKO.onrender.com/api/harakapay/webhook
```

Backend inaituma URL hii moja kwa moja kwenye kila request ya `POST /api/v1/collect`
kupitia field `webhook_url` — huhitaji kuisajili popote pengine isipokuwa kuhakikisha
`APP_BASE_URL` kwenye Render env vars ni sahihi.

---

## 6. JINSI YA KU-TEST MALIPO

1. Fungua website yako (`https://weka-render-domain-yako.onrender.com`).
2. Jisajili na email + namba ya simu halisi ya Kitanzania (Tigo Pesa / M-Pesa / Airtel Money
   n.k., kulingana na HarakaPay inavyounga mkono).
3. Ongeza Product moja kwanza kupitia `admin.html` (baada ya kujiweka kama admin — angalia 3.3).
4. Kwenye Home, bofya **BUY NOW** kwenye product hiyo -> jaza namba ya simu -> **PAY NOW**.
5. Utapokea **USSD Push** halisi kwenye simu yako — thibitisha PIN yako.
6. Ukisha thibitisha, HarakaPay itatuma webhook kwenda backend yako, na dashboard
   itaonyesha **PAYMENT SUCCESSFUL** + link ya kikundi.
7. Kama unataka kutest bila kulipa fedha halisi, uliza HarakaPay kama wana **sandbox/test mode**
   — API hii tuliyopewa haikutaja sandbox endpoint tofauti, kwa hiyo kwa sasa fanya
   malipo madogo halisi (mfano TZS 500-1000) kwa ajili ya kupima mfumo mzima.
8. Angalia **Render Logs** (`Logs` tab kwenye Render dashboard) endapo kuna hitilafu kwenye
   `/api/payment/create` au `/api/harakapay/webhook`.

---

## 7. MUHTASARI WA MAJIBU (MASWALI YAKO)

1. **Firebase credentials (client) niweke wapi?**
   Kwenye `public/firebase-config.js`, sehemu ya `firebaseConfig` — hizi SI siri.

2. **Firebase Admin credentials (backend) niweke wapi?**
   Kwenye **Render Environment Variables**: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`,
   `FIREBASE_PRIVATE_KEY`. Kamwe kwenye GitHub au frontend.

3. **HarakaPay API key niweke wapi?**
   Kwenye **Render Environment Variables** pekee: `HARAKAPAY_API_KEY`. Haipo kwenye
   `index.html`, `admin.html`, `app.js`, `admin.js` wala kwenye GitHub.

4. **Render URL niweke wapi?**
   - `public/firebase-config.js` -> `API_BASE_URL` (frontend inatumia hii kuita backend yako)
   - Render Environment Variable `APP_BASE_URL` (backend inatumia hii kutengeneza webhook_url)

5. **Webhook URL itakuwa nini?**
   `https://WEKA-RENDER-DOMAIN-YAKO.onrender.com/api/harakapay/webhook` — inatumwa
   automatically na backend kwenye kila request ya malipo.

6. **Environment Variables za Render (orodha kamili):**
   `HARAKAPAY_API_KEY`, `HARAKAPAY_BASE_URL`, `APP_BASE_URL`,
   `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `PORT` (hiari,
   Render huweka yenyewe).

7. **Jinsi ya deploy GitHub -> Render:**
   `git init` -> `git add .` -> `git commit` -> tengeneza repo GitHub -> `git push` ->
   Render -> New Web Service -> unganisha repo -> weka Build/Start command na Environment
   Variables -> Deploy.

8. **Jinsi ya kutest payment:**
   Angalia sehemu ya 6 hapo juu — fanya malipo halisi madogo kupitia USSD Push halisi
   kwani API uliyopewa haina sandbox endpoint iliyoainishwa.

---

## 8. USALAMA (MUHIMU KUKUMBUKA)

- `HARAKAPAY_API_KEY` haiguswi na frontend kamwe — backend pekee ndiyo inayowasiliana
  na `harakapay.net`.
- Payment success **haiamuliwi na frontend** — backend pekee (kupitia webhook au status
  check) ndiyo inayobadilisha `paymentStatus` kwenye Firestore. Firestore Rules zinazuia
  client kuandika/kubadilisha `orders` moja kwa moja (`allow create: if false`,
  `allow update: if isAdmin()`), backend inatumia Firebase **Admin SDK** ambayo inapita
  rules hizi kihalali.
- Webhook ni **idempotent** — order isiyobadilishwa mara mbili hata ikiwa HarakaPay
  itatuma notification zaidi ya mara moja.
- Kila mtumiaji anaona **orders zake tu** (Firestore Rules + backend zote zinathibitisha
  `userId == request.auth.uid`).
- Admin panel inalindwa na Firebase Auth + collection ya `admins` (whitelist ya UID).

Kila la kheri na mradi wako! 🚀
