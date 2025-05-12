require("dotenv").config(); // Load environment variables

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure directories exist
const uploadDir = path.join(__dirname, "uploads");
const processedDir = path.join(__dirname, "processed");
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(processedDir, { recursive: true });
fs.chmodSync(processedDir, 0o777);

// Utility functions
function wrapText(text, maxLength = 30) {
  const words = text.split(" ");
  let lines = [];
  let currentLine = words[0];

  for (let i = 1; i < words.length; i++) {
    if (currentLine.length + words[i].length + 1 <= maxLength) {
      currentLine += " " + words[i];
    } else {
      lines.push(currentLine);
      currentLine = words[i];
    }
  }
  lines.push(currentLine);
  return lines.join("\n");
}

function escapeText(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n");
}

// FFmpeg processing
function processVideoWithBackground(videoPath, backgroundPath, outputPath, textData = {}) {
  return new Promise((resolve, reject) => {
    const { doctorName = "", degree = "", mobile = "", address = "" } = textData;

    const wrappedDoctorName = wrapText(`Doctor: ${doctorName}`);
    const wrappedDegree = wrapText(`Degree: ${degree}`);
    const wrappedMobile = wrapText(`Mobile: ${mobile}`);
    const wrappedAddress = wrapText(`Address: ${address}`);

    const rawTextBlock = `${wrappedDoctorName}\n${wrappedMobile}\n${wrappedAddress}\n${wrappedDegree}`;
    const textBlock = escapeText(rawTextBlock);

    ffmpeg()
      .input(backgroundPath)
      .input(videoPath)
      .complexFilter([
        "[0:v]scale=960:720[bg]",
        "[1:v]scale=-1:720[vid]",
        "[bg][vid]overlay=x=(W-w)/2:y=0[tmp]",
        {
          filter: "drawtext",
          options: {
            fontfile: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            text: textBlock,
            fontsize: 20,
            fontcolor: "white",
            box: 1,
            boxcolor: "black@0.9",
            boxborderw: 30,
            x: 50,
            y: "h-text_h",
            line_spacing: 10,
            fix_bounds: 1,
          },
          inputs: "tmp",
          outputs: "final",
        },
      ])
      .outputOptions(["-map", "[final]", "-map", "1:a?", "-c:a", "copy", "-y"])
      .output(outputPath)
      .on("start", (cmd) => console.log("FFmpeg command:", cmd))
      .on("end", () => resolve())
      .on("error", reject)
      .run();
  });
}

// Multer setup
const ALLOWED_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/jpg",
];

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const safeName = `${Date.now()}_${file.originalname.replace(/[<>:"/\\|?*]/g, "_")}`;
    cb(null, safeName);
  },
});

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid file type."), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
}).fields([
  { name: "video", maxCount: 1 },
  { name: "background", maxCount: 1 },
]);

// API Route
app.post("/upload", (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).send({ error: err.message });

    try {
      if (!req.files || !req.files.video) return res.status(400).send({ error: "No video uploaded." });

      const { doctorName, degree, mobile, address } = req.body;
      if (!doctorName || !degree || !mobile || !address) {
        if (req.files.video) fs.unlinkSync(req.files.video[0].path);
        if (req.files.background) fs.unlinkSync(req.files.background[0].path);
        return res.status(400).send({ error: "All fields are required." });
      }

      const videoPath = req.files.video[0].path;
      const backgroundPath = req.files.background ? req.files.background[0].path : null;
      const safeFilename = `output_${Date.now()}.mp4`;
      const outputPath = path.join(processedDir, safeFilename);

      await processVideoWithBackground(videoPath, backgroundPath, outputPath, {
        doctorName,
        degree,
        mobile,
        address,
      });

      if (req.files.background) fs.unlinkSync(req.files.background[0].path);
      fs.unlinkSync(videoPath);

      res.status(200).send({
        message: "Video processed successfully.",
        file: safeFilename,
        downloadUrl: `/processed/${safeFilename}`,
      });
    } catch (error) {
      console.error("Processing error:", error);
      if (req.files?.video) fs.unlinkSync(req.files.video[0].path);
      if (req.files?.background) fs.unlinkSync(req.files.background[0].path);
      res.status(500).send({ error: error.message });
    }
  });
});

// Serve processed files
app.use("/processed", express.static(processedDir));

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
