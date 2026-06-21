import "./env.js";
import { createApp } from "./app.js";
import { initDb } from "./db.js";

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";

initDb()
  .then(() => {
    createApp().listen(port, host, () => {
      console.log(`Fyxor API listening on http://${host}:${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialise the database. Is Postgres running and DATABASE_URL set?");
    console.error(error);
    process.exit(1);
  });
