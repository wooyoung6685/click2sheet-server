const { google } = require("googleapis");
const sheets = google.sheets("v4");
const dotenv = require("dotenv");

// 인증 설정 (OAuth2.0)
const auth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "/auth/google/callback"
);
auth.setCredentials({ access_token: ACCESS_TOKEN });

// 시트 ID와 탭 이름 설정
const spreadsheetId =
  "https://docs.google.com/spreadsheets/d/19-3Y2X-O8lva6dkUWfcsZckem96NjaTwczW6akm2pvw/edit?gid=155493492#gid=155493492";
const range = "SA_DAILY_네이버"; // 가져올 탭 이름과 범위

// 데이터 가져오기
async function getSheetData() {
  const res = await sheets.spreadsheets.values.get({
    auth,
    spreadsheetId,
    range,
  });
  console.log(res.data.values); // 시트 데이터를 출력
}

getSheetData();
