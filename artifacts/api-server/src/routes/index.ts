import { Router, type IRouter } from "express";
import healthRouter from "./health";
import roomsRouter from "./rooms";
import videoRouter from "./video";
import membersRouter from "./members";
import bansRouter from "./bans";
import autoSessionRouter from "./auto-session";
import hyperbeamRouter from "./hyperbeam";
import iceRouter from "./ice";
import embedProxyRouter from "./embed-proxy";   // <-- ADD THIS LINE

const router: IRouter = Router();
router.use(healthRouter);
router.use(roomsRouter);
router.use(videoRouter);
router.use(membersRouter);
router.use(bansRouter);
router.use(autoSessionRouter);
router.use(hyperbeamRouter);
router.use(iceRouter);
router.use(embedProxyRouter);                   // <-- ADD THIS LINE

export default router;
