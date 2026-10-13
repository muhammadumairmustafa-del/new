// Vercel serverless entry: the whole Express API runs as one function; the React app is served statically from dist/.
import { createApp } from "../server/app.js";

export default createApp().app;
