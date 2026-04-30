const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
require("dotenv").config();

const jar = new CookieJar();
const client = wrapper(axios.create({ jar }));

const GIB_URLS = {
    CAPTCHA: "https://dijital.gib.gov.tr/apigateway/captcha/getnewcaptcha",
    LOGIN: "https://dijital.gib.gov.tr/apigateway/auth/tdvd/login",
    STATS: "https://dijital.gib.gov.tr/apigateway/etebligat/etebligat/tebligat-sayilari",
    KARSIT_INCELEME_AUTH:
        "https://dijital.gib.gov.tr/apigateway/auth/tdvd/karsit-inceleme-cevabi",
    EYMM_CHECK_CODE:
        "https://eymm.gib.gov.tr/apigateway/ymm-auth/login/check-code",
    EYMM_LISTELE:
        "https://eymm.gib.gov.tr/apigateway/ymm/karsit-cevap-yazisi/gelen-ve-cevap-verilen-listele",
};

const HEADERS = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,tr;q=0.8",
    Referer: "https://dijital.gib.gov.tr/",
    "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
};

async function solveCaptchaAI(base64Image) {
    try {
        const captchaPath = path.join(__dirname, "captcha.png");
        const base64Data = base64Image.replace(/^data:image\/png;base64,/, "");
        fs.writeFileSync(captchaPath, base64Data, "base64");
        
        // Sunucuda venv kullanıldığı için venv yolunu belirtiyoruz
        const pythonPath = fs.existsSync(path.join(__dirname, "venv", "bin", "python3")) 
            ? "./venv/bin/python3" 
            : "python3";

        const result = execSync(`${pythonPath} solver.py "${captchaPath}"`, {
            encoding: "utf8",
        });
        return result.trim();
    } catch (err) {
        return null;
    }
}

// Tarih Fonksiyonları
function getCriticalDate(dateStr) {
    if (!dateStr) return null;
    const [d, m, y] = dateStr.split(".").map(Number);
    const date = new Date(y, m - 1, d);
    date.setMonth(date.getMonth() + 1);
    return date;
}

function formatDate(date) {
    return `${date.getDate().toString().padStart(2, "0")}.${(date.getMonth() + 1).toString().padStart(2, "0")}.${date.getFullYear()}`;
}

async function sendTelegramMessage(text) {
    const token = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: text,
            parse_mode: "HTML",
        });
        console.log("✅ Rapor Telegram'a gönderildi.");
    } catch (err) {
        console.error("❌ Telegram hatası:", err.message);
    }
}

async function processCompany(company) {
    let attempts = 0;
    const maxAttempts = 6;
    const resultData = {
        sirket: company.SIRKET_ADI,
        tebligat: 0,
        karsitNormal: [],
        karsitUrgent: [],
        success: false,
    };

    console.log(`\n🏢 [${company.SIRKET_ADI}] İşleniyor...`);

    while (attempts < maxAttempts) {
        attempts++;
        try {
            const captchaRes = await client.get(GIB_URLS.CAPTCHA, {
                headers: HEADERS,
            });
            const { captchaImgBase64, cid } = captchaRes.data;
            const captchaCode = await solveCaptchaAI(captchaImgBase64);
            if (!captchaCode) continue;

            const loginRes = await client.post(
                GIB_URLS.LOGIN,
                {
                    dk: captchaCode,
                    userid: company.USERID,
                    sifre: company.SIFRE,
                    imageId: cid,
                },
                { headers: HEADERS },
            );

            if (!loginRes.data.result) {
                if (
                    loginRes.data.messages &&
                    loginRes.data.messages[0].text.includes("Güvenlik kodu")
                )
                    continue;
                return resultData;
            }

            const token = loginRes.data.token;
            const authHeaders = {
                ...HEADERS,
                Authorization: `Bearer ${token}`,
            };

            // 1. Tebligat Sayıları
            const statsRes = await client.get(GIB_URLS.STATS, {
                headers: authHeaders,
            });
            resultData.tebligat =
                statsRes.data.digerKurumOkunmamisTebligatSayisi || 0;

            // 2. EYMM Tutanaklar
            const karsitAuthRes = await client.get(
                GIB_URLS.KARSIT_INCELEME_AUTH,
                { headers: authHeaders },
            );
            const gecisCode = new URL(
                karsitAuthRes.data.redirectUrl,
            ).searchParams.get("gecisCode");
            const gecisRes = await client.get(
                `${GIB_URLS.EYMM_CHECK_CODE}?gecisCode=${gecisCode}`,
                { headers: authHeaders },
            );

            const eymmToken = gecisRes.data.ymmToken;
            const today = new Date();
            const lastYear = new Date();
            lastYear.setFullYear(today.getFullYear() - 1);

            const eymmRes = await client.post(
                GIB_URLS.EYMM_LISTELE,
                {
                    data: {
                        basTarihi: formatDate(lastYear),
                        bitTarihi: formatDate(today),
                    },
                    meta: {
                        pagination: { pageNo: 1, pageSize: 20 },
                        sortFieldName: "sonDuzenlemeTarihi",
                        sortType: "DESC",
                    },
                },
                {
                    headers: {
                        ...HEADERS,
                        Authorization: `Bearer ${eymmToken}`,
                    },
                },
            );

            const tutanaklar = eymmRes.data.gelenVeCevapVerilenDtoList || [];
            const sevenDaysLater = new Date();
            sevenDaysLater.setDate(today.getDate() + 7);

            tutanaklar
                .filter((t) => t.durum === "Cevap Bekliyor")
                .forEach((t) => {
                    const critDate = getCriticalDate(t.ymmOnayTarihi);
                    const item = { tarih: formatDate(critDate) };

                    if (critDate <= sevenDaysLater) {
                        resultData.karsitUrgent.push(item);
                    } else {
                        resultData.karsitNormal.push(item);
                    }
                });

            resultData.success = true;
            console.log(`✅ ${company.SIRKET_ADI} tamamlandı.`);
            return resultData;
        } catch (err) {
            if (attempts >= maxAttempts)
                console.log(`🛑 ${company.SIRKET_ADI} hatası: ${err.message}`);
        }
    }
    return resultData;
}

async function main() {
    const companies = JSON.parse(
        fs.readFileSync(path.join(__dirname, "companies.json"), "utf8"),
    );
    const reports = [];

    for (const company of companies) {
        reports.push(await processCompany(company));
        await jar.removeAllCookies();
    }

    // Mesaj Oluşturma
    const hasUrgent = reports.some((r) => r.karsitUrgent.length > 0);
    const hasTebligat = reports.some((r) => r.tebligat > 0);
    const hasNormalKarsit = reports.some((r) => r.karsitNormal.length > 0);
    const failedOnes = reports.filter((r) => !r.success);

    let title = hasUrgent ? "⚠️ <b>GÜNLÜK ÖZET</b> ⚠️" : "<b>GÜNLÜK ÖZET</b>";
    let message = `${title}\n`;

    if (!hasTebligat && !hasUrgent && !hasNormalKarsit) {
        message += "\n✅ <b>Tüm şirketler güncel.</b>\n";
        message +=
            "Okunmamış tebligat veya bekleyen Karşıt İnceleme tutanağı bulunmuyor.\n";
    } else {
        if (hasTebligat) {
            message += "\n<b>✉️ Okunmamış tebligatı olan şirketler:</b>\n";
            reports
                .filter((r) => r.tebligat > 0)
                .forEach((r) => {
                    message += `• ${r.sirket} (${r.tebligat})\n`;
                });
        }

        if (hasUrgent) {
            message += "\n⚠️ <b>SÜRESİ AZALAN K.İ. TUTANAKLARI</b>\n";
            reports
                .filter((r) => r.karsitUrgent.length > 0)
                .forEach((r) => {
                    const tarihler = r.karsitUrgent
                        .map((k) => k.tarih)
                        .join(", ");
                    message += `• ${r.sirket} (Son Cevap: ${tarihler})\n`;
                });
        }

        if (hasNormalKarsit) {
            message +=
                "\n<b>🔍 Cevap bekleyen K.İ. Tutanağı olan şirketler:</b>\n";
            reports
                .filter((r) => r.karsitNormal.length > 0)
                .forEach((r) => {
                    const tarihler = r.karsitNormal
                        .map((k) => k.tarih)
                        .join(", ");
                    message += `• ${r.sirket} (Son Cevap: ${tarihler})\n`;
                });
        }
    }

    if (failedOnes.length > 0) {
        message += "\n<b>🚫 Giriş yapılamayan şirketler:</b>\n";
        message += failedOnes.map((r) => r.sirket).join(", ") + "\n";
    }

    console.log("\n" + message);
    await sendTelegramMessage(message);
}

main();
