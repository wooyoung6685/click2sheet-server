require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const session = require("express-session");
const MongoStore = require("connect-mongo"); // 추가된 부분
const cors = require("cors");
const { google } = require("googleapis");

const app = express();

// MongoDB 연결
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// CORS 설정
app.use(
  cors({
    origin: process.env.ORIGIN_URI,
    credentials: true,
  })
);

// 세션 설정 (수정된 부분)
app.use(
  session({
    secret: "-secret-",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }), // MongoDB에 세션 저장
    cookie: {
      secure: false,
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

// Passport 초기화
app.use(passport.initialize());
app.use(passport.session());

// Passport 전략 설정
const User = require("./models/User");

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "/auth/google/callback",
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        let user = await User.findOne({ googleId: profile.id });

        if (!user) {
          user = new User({
            googleId: profile.id,
            displayName: profile.displayName,
            accessToken,
            refreshToken,
          });
          await user.save();
        } else {
          user.accessToken = accessToken;
          await user.save();
        }

        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  )
);

// 세션 직렬화
passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err);
  }
});

// 라우트 설정
app.get(
  "/auth/google",
  passport.authenticate("google", {
    scope: ["profile", "https://www.googleapis.com/auth/spreadsheets"],
  })
);

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/login" }),
  (req, res) => {
    res.redirect(process.env.ORIGIN_URI);
  }
);

app.post("/auth/logout", async (req, res) => {
  try {
    // req.logout()에 콜백 함수 전달
    req.logout((err) => {
      if (err) {
        console.error("로그아웃 처리 중 오류:", err);
        return res.status(500).send("로그아웃 실패");
      }

      // 세션을 종료하고 쿠키 삭제
      req.session.destroy((err) => {
        if (err) {
          console.error("세션 삭제 중 오류:", err);
          return res.status(500).send("세션 삭제 중 오류");
        }
        res.clearCookie("connect.sid"); // 세션 쿠키 삭제
        res.status(200).send("로그아웃 완료");
      });
    });
  } catch (error) {
    console.error("로그아웃 처리 중 오류:", error);
    res.status(500).send("서버 오류");
  }
});

app.get("/auth/user", (req, res) => {
  if (req.user) {
    res.json(req.user);
  } else {
    res.status(401).json({ error: "Not authenticated" });
  }
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
