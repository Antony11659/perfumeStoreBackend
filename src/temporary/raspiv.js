// TEMPORARY:
// Stores the current Raspiv workflow until the database-backed
// order/session system is implemented

import fs from "node:fs";

const RASPIV_SESSION_FILE = "./data/raspiv-session.json";

export const saveRaspivSession = (products) => {
  fs.mkdirSync("./data", { recursive: true });
  
  fs.writeFileSync(
    RASPIV_SESSION_FILE,
    JSON.stringify(products, null, 2)
  );
};

export const getRaspivSession = () => {
    const data = fs.readFileSync(
      RASPIV_SESSION_FILE,
      "utf8"
    );
  
    return JSON.parse(data);
  };