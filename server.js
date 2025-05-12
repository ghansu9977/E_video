require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const cors = require("cors");


ffmpeg.setFfmpegPath(ffmpegPath);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors());

// Directories
const uploadDir = path.join(__dirname, "uploads");
const processedDir = path.join(__dirname, "processed");
const fontPath = path.join(__dirname, "fonts", "DejaVuSans-Bold.ttf"); 

// Ensure directories exist
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });

// Utility functions
function wrapText(text, maxLength = 30) {
    const words = text.split(" ");
    let lines = [];
    let currentLine = words[0];

    for (let i = 1; i < words.length; i++) {
        if ((currentLine + " " + words[i]).length <= maxLength) {
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
        .replace(/\\/g, "\\\\")   // backslash
        .replace(/:/g, "\\:")     // colon
        .replace(/,/g, "\\,")     // comma
        .replace(/\./g, "\\.")    // dot
        .replace(/'/g, "\\'")     // single quote
        .replace(/\n/g, "\\n");   // newline
}

// FFmpeg logic
function processVideoWithBackground(videoPath, backgroundPath, outputPath, textData = {}) {
    return new Promise((resolve, reject) => {
        const { doctorName = "", degree = "", mobile = "", address = "" } = textData;

        const textBlock = `'${escapeText(
            `${wrapText(`Doctor: ${doctorName}`)}\n${wrapText(`Mobile: ${mobile}`)}\n${wrapText(`Address: ${address}`)}\n${wrapText(`Degree: ${degree}`)}`
        )}'`;

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
                        fontfile: fontPath,
                        text: textBlock,
                        fontsize: 20,
                        fontcolor: "white",
                        box: 1,
                        boxcolor: "black@0.8",
                        boxborderw: 20,
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
            .on("start", (cmd) => console.log("Running FFmpeg:", cmd))
            .on("end", () => resolve())
            .on("error", (err) => reject(err))
            .run();
    });
}

// Multer config
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) =>
            cb(null, Date.now() + "_" + file.originalname.replace(/[<>:"/\\|?*]/g, "_")),
    }),
    fileFilter: (req, file, cb) => {
        const allowed = ["video/mp4", "image/jpeg", "image/png"];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error("Invalid file type"));
    },
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
}).fields([
    { name: "video", maxCount: 1 },
    { name: "background", maxCount: 1 },
]);

// Upload API
app.post("/upload", (req, res) => {
    upload(req, res, async (err) => {
        if (err) return res.status(400).send({ error: err.message });

        const { doctorName, degree, mobile, address } = req.body;
        const videoFile = req.files?.video?.[0];
        const bgFile = req.files?.background?.[0];

        if (!videoFile || !bgFile || !doctorName || !degree || !mobile || !address) {
            return res.status(400).send({ error: "All fields and files are required." });
        }

        const outputPath = path.join(processedDir, `output_${Date.now()}.mp4`);

        try {
            await processVideoWithBackground(videoFile.path, bgFile.path, outputPath, {
                doctorName,
                degree,
                mobile,
                address,
            });

            // Clean up uploads
            fs.unlinkSync(videoFile.path);
            fs.unlinkSync(bgFile.path);

            const outputName = path.basename(outputPath);
            res.send({
                message: "Video processed successfully.",
                file: outputName,
                downloadUrl: `/processed/${outputName}`,
            });
        } catch (error) {
            console.error("FFmpeg Error:", error.message);
            res.status(500).send({ error: "Video processing failed." });
        }
    });
});

// Serve processed video
app.use("/processed", express.static(processedDir));

// Start server
app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
});
