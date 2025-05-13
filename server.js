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
function wrapText(text, maxLength = 50) {
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
    return `'${text
        .replace(/\\/g, "\\\\")
        .replace(/:/g, "\\:")
        .replace(/'/g, "\\'")}'`;
}

// FFmpeg logic
async function processVideoWithBackground(videoPath, backgroundPath, outputPath, textData = {}) {
    return new Promise((resolve, reject) => {
        const { doctorName = "", degree = "", mobile = "", address = "" } = textData;

        const wrappedDoctorName = wrapText(`Doctor: ${doctorName}`);
        const wrappedMobile = wrapText(`Mobile: ${mobile}`);
        const wrappedAddress = wrapText(`Address: ${address}`);
        const wrappedDegree = wrapText(`Degree: ${degree}`);

        const textBlock = escapeText(`${wrappedDoctorName}\n${wrappedMobile}\n${wrappedAddress}\n${wrappedDegree}`);

        ffmpeg()
            .input(backgroundPath)
            .input(videoPath)
            .complexFilter([
                "[0:v]scale=960:720[bg]",
                "[1:v]scale=-1:720[vid]",
                "[bg][vid]overlay=x=(W-w)/2:y=0[tmp]",
                {
                    filter: "drawbox",
                    options: {
                        x: 0,
                        y: "h-(h-1000)/2",
                        width: "iw",
                        height: 170,
                        color: "black@1.0",
                        t: "fill",
                    },
                    inputs: "tmp",
                    outputs: "boxed",
                },
                {
                    filter: "drawtext",
                    options: {
                        fontfile: fontPath,
                        text: textBlock,
                        fontsize: 24,
                        fontcolor: "white",
                        box: 0,
                        x: "(w-text_w)/2",
                        y: "h-90",
                        line_spacing: 10,
                        fix_bounds: 1,
                    },
                    inputs: "boxed",
                    outputs: "final",
                },
            ])
            .outputOptions(["-map", "[final]", "-map", "1:a?", "-c:a", "copy", "-y"])
            .output(outputPath)
            .on("start", (cmd) => console.log("Processing started:", cmd))
            .on("end", () => {
                console.log("Successfully processed:", outputPath);
                resolve();
            })
            .on("error", (err) => {
                console.error("Processing failed:", err);
                reject(err);
            })
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
        try {
            if (err) return res.status(400).send({ error: err.message });
            if (!req.files || !req.files.video)
                return res.status(400).send({ error: "No video file uploaded" });

            const { doctorName, degree, mobile, address } = req.body;
            if (!doctorName || !degree || !mobile || !address) {
                if (req.files.video) fs.unlinkSync(req.files.video[0].path);
                if (req.files.background) fs.unlinkSync(req.files.background[0].path);
                return res.status(400).send({ error: "All fields are required" });
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

            // Cleanup
            if (req.files.background) fs.unlinkSync(req.files.background[0].path);
            fs.unlinkSync(videoPath);

            res.status(200).send({
                message: "Video processed successfully",
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

// Serve processed video
app.use("/processed", express.static(processedDir));

// Start server
app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
});
