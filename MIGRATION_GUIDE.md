# 🌌 LIYA Migration & Setup Guide (Hinglish)

Agar aapko LIYA Neural OS ko kisi doosre laptop ya system par shift karna hai, toh is guide ko step-by-step follow karein. 

Humne already aapke models ka backup ek single folder **`face_swap_models_backup`** me bana diya hai.

---

## 📋 Prerequisites (Naye Laptop Par Kya Install Karna Hoga?)

Sabse pehle naye system par niche likhi cheezein install karein:
1. **Node.js (v18 ya v20)**: [Download Node.js](https://nodejs.org/) (Frontend aur Backend chalane ke liye).
2. **Python (3.10 ya 3.11)**: [Download Python](https://www.python.org/) (Face Swap engine ke liye).
   * *⚠️ Important:* Installation ke waqt **"Add Python to PATH"** checkbox ko jarur check karein.
3. **FFmpeg**: Video face swap audio muxing ke liye.
   * [FFmpeg Guide](https://www.ffmpeg.org/download.html) download karein aur use system environment variables (`PATH`) me add karein.

---

## 🚀 Step-by-Step Migration Steps

### Step 1: Codebase Transfer
1. Apne purane laptop se poora `liya` folder naye laptop par copy/paste karein.
2. Apne Google Drive se **`face_swap_models_backup`** folder ko download karein.

---

### Step 2: Model Files Positioning (Sabse Important)
Aapke download kiye gaye backup folder ke andar 2 main assets hain:

#### A. Inswapper Model (`inswapper_128.onnx`):
1. Naye laptop par project folder ke andar is path par jayein: `liya/backend/bin/`
2. Agar wahan `models` naam ka folder nahi hai, toh ek naya folder banayein jiska naam **`models`** ho.
3. Google Drive wale backup se `inswapper_128.onnx` file ko copy karke is folder ke andar daal dein:
   * **Path**: `liya/backend/bin/models/inswapper_128.onnx`

#### B. InsightFace Models (`buffalo_l`):
1. Naye laptop par apne user home directory me jayein (e.g., `C:\Users\<Aapka_Naya_Username>\`).
2. Wahan `.insightface` naam ka folder check karein. Agar nahi hai, toh use create karein:
   * Windows me path aisa banna chahiye: `C:\Users\<Aapka_Naya_Username>\.insightface\models\`
3. Google Drive backup se poora **`buffalo_l`** folder (jisme 5 `.onnx` files hain) copy karke yahan paste kar dein:
   * **Target Path**: `C:\Users\<Aapka_Naya_Username>\.insightface\models\buffalo_l\`

---

### Step 3: Node Dependencies Install Karein
Apna terminal (Command Prompt ya PowerShell) open karein aur project ke root folder (`liya/`) me jayein:

1. **Root (Frontend) dependencies install karein:**
   ```bash
   npm install
   ```
2. **Backend dependencies install karein:**
   ```bash
   npm install --prefix backend
   ```

---

### Step 4: Python Libraries Install Karein
Terminal me `backend/bin` folder ke andar jayein aur naye laptop par required Python modules install karein:
```bash
cd backend/bin
pip install -r requirements.txt
```

---

### Step 5: Web Scraper (Playwright) Setup
LIYA ke smart web browser tool ko active karne ke liye naye laptop par Chromium browser install karein:
```bash
npx playwright install chromium --with-deps
```

---

### Step 6: Start LIYA Neural OS
Ab aapka system completely migrate ho chuka hai! System run karne ke liye root folder se command run karein:
```bash
npm start
```
* **Frontend**: `http://localhost:5173` par live ho jayega.
* **Backend**: `http://localhost:3000` par run karega.

---

## 🛠️ Troubleshooting (Naye Laptop Par Aane Wale Common Issues)

* **Issue: "Python is not recognized as an internal or external command"**
  * **Solution**: Naye laptop par Python install toh hai par PATH variable me set nahi hai. Python reinstall karein aur "Add Python to PATH" check karein, ya manually system settings me PATH variable update karein.
* **Issue: "FFmpeg error during video face swap"**
  * **Solution**: FFmpeg properly configured nahi hai. Terminal me `ffmpeg -version` chalakar test karein ki command chal rahi hai ya nahi.
* **Issue: Face swap fails on first run**
  * **Solution**: Double check karein ki `.insightface/models/buffalo_l/` directory me paacho `.onnx` files (det_10g, w600k_r50, etc.) sahi path par copied hain ya nahi.
