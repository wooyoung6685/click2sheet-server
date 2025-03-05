const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { google } = require("googleapis");
const passport = require("passport");
const session = require("express-session");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

dotenv.config();
const app = express();

app.use(cors({ origin: process.env.ORIGIN_URL, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({ secret: "mysecret", resave: false, saveUninitialized: true })
);
app.use(passport.initialize());
app.use(passport.session());

app.get("/", (req, res) => res.send("Express on Vercel"));

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "/auth/google/callback",
    },
    (accessToken, refreshToken, profile, done) => {
      profile.accessToken = accessToken;
      return done(null, profile);
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.get(
  "/auth/google",
  passport.authenticate("google", {
    scope: ["profile", "email", "https://www.googleapis.com/auth/spreadsheets"],
  })
);

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => res.redirect("http://localhost:3000")
);

app.get("/auth/user", (req, res) => res.json({ user: req.user || null }));

app.get("/auth/logout", (req, res) => {
  req.logout(() => req.session.destroy());
  res.json({ message: "Logged out successfully" });
});

const TEMPLATE_SHEET_ID = process.env.TEMPLATE_SHEET_ID; // 템플릿 시트 ID

app.post("/create-sheet", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: req.user.accessToken });

  const sheets = google.sheets({ version: "v4", auth });
  const { title, tabs = [] } = req.body;

  try {
    // 1. 새 스프레드시트 생성 (기본적으로 "Sheet1" 탭 포함)
    const createResponse = await sheets.spreadsheets.create({
      resource: { properties: { title: title || "New Google Sheet" } },
    });
    const newSpreadsheetId = createResponse.data.spreadsheetId;

    // 2. 템플릿 시트에서 선택한 탭들을 복사하고, 이름을 원래대로 변경
    let requests = [];
    for (const tab of tabs) {
      // 템플릿 시트의 탭 정보 가져오기
      const templateSheetInfo = await sheets.spreadsheets.get({
        spreadsheetId: TEMPLATE_SHEET_ID,
      });
      const templateSheet = templateSheetInfo.data.sheets.find(
        (s) => s.properties.title === tab
      );
      if (!templateSheet) continue;
      const templateSheetId = templateSheet.properties.sheetId;

      // 템플릿 시트의 해당 탭을 새 스프레드시트로 복사
      const copyResponse = await sheets.spreadsheets.sheets.copyTo({
        spreadsheetId: TEMPLATE_SHEET_ID,
        sheetId: templateSheetId,
        requestBody: { destinationSpreadsheetId: newSpreadsheetId },
      });
      const newSheetTabId = copyResponse.data.sheetId;

      // 복사된 탭 이름을 원래 이름(예: "SA_DAILY_네이버")으로 변경 (자동으로 붙는 "의 사본" 제거)
      requests.push({
        updateSheetProperties: {
          properties: { sheetId: newSheetTabId, title: tab },
          fields: "title",
        },
      });
    }

    if (requests.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: newSpreadsheetId,
        requestBody: { requests },
      });
    }

    // 3. 복사된 탭이 존재하면 기본 "Sheet1" 탭 삭제 (삭제 가능한 시트가 2개 이상일 때)
    const currentSpreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: newSpreadsheetId,
    });
    if (currentSpreadsheet.data.sheets.length > 1) {
      // 기본 생성된 첫번째 시트의 sheetId 사용
      const defaultSheetId = createResponse.data.sheets[0].properties.sheetId;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: newSpreadsheetId,
        requestBody: {
          requests: [{ deleteSheet: { sheetId: defaultSheetId } }],
        },
      });
    }

    res.json({
      url: `https://docs.google.com/spreadsheets/d/${newSpreadsheetId}/edit`,
    });
  } catch (error) {
    console.error("Error creating spreadsheet:", error);
    res
      .status(500)
      .json({ error: "Failed to create spreadsheet", details: error.message });
  }
});

app.listen(5001, () => console.log("Server running on port 5001"));
