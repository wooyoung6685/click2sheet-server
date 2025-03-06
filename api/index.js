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

const mongoose = require("mongoose");

mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

app.use(
  session({
    secret: "mysecret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000, // 24시간 유효
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

app.get("/", (req, res) => res.send("Express on Vercel"));

const User = require("./models/User");

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "https://click2sheet-server.vercel.app/auth/google/callback",
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const { id, displayName, emails, photos } = profile;

        // MongoDB에서 사용자 검색
        let user = await User.findOne({ googleId: id });

        // 새 사용자면 저장 (회원가입 처리)
        if (!user) {
          user = new User({
            googleId: id,
            email: emails[0].value,
            name: displayName,
            picture: photos[0].value,
          });
          await user.save();
        }

        // 사용자 정보에 accessToken 추가
        user.accessToken = accessToken;
        return done(null, user);
      } catch (error) {
        return done(error, null);
      }
    }
  )
);

passport.serializeUser((user, done) => done(null, user.googleId));

passport.deserializeUser(async (googleId, done) => {
  try {
    const user = await User.findOne({ googleId });
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

app.get(
  "/auth/google",
  passport.authenticate("google", {
    scope: ["profile", "email", "https://www.googleapis.com/auth/spreadsheets"],
  })
);

const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");

app.use(cookieParser());

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication failed" });
    }

    // JWT 발급
    const token = jwt.sign(
      { id: req.user._id, email: req.user.email },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );

    // 쿠키에 JWT 저장
    res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.redirect("https://click2sheet-client.vercel.app");
  }
);

app.get("/auth/user", async (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("-googleId");

    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({ user });
  } catch (error) {
    res.status(401).json({ error: "Invalid token" });
  }
});

app.get("/auth/logout", (req, res) => {
  res.clearCookie("token");
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
