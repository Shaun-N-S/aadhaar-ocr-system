import cors from "cors";
import express from "express";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware";
import routes from "./routes";

const app = express();

app.disable("x-powered-by");

app.use(cors({ origin: env.FRONTEND_URL }));
app.use(express.json({ limit: "100kb" }));

app.use("/api", routes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
