import { Router } from "express";
import { extractAadhaarDetails } from "../controller/ocr.controller";
import { reserveOcrCapacity } from "../middleware/ocr-capacity.middleware";
import { uploadAadhaarImages } from "../middleware/upload.middleware";

const router = Router();

// Capacity is reserved before the upload is buffered.
router.post("/", reserveOcrCapacity, uploadAadhaarImages, extractAadhaarDetails);

export default router;
