const path = require('path');  // Only declare path once
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
console.log("DB_PASSWORD from env:", process.env.DB_PASSWORD); // ADDED LINE
const logoPath = path.join(__dirname, "..", "assets", "logo.png");
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk'); // Anthropic SDK इम्पोर्ट करें
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const bodyParser = require('body-parser');
const fs = require('fs');
const multer = require("multer");
const PDFDocument = require('pdfkit');
const QRCode = require("qrcode");
const fetch = require('node-fetch'); // fetch API इम्पोर्ट करें (पुराने Node.js के लिए)


// मॉडल्स इनिशियलाइज़ करें
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-pro" }); // <-- यहाँ ठीक से परिभाषित!

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
const port = 5000;

// PostgreSQL Pool Configuration using environment variables
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.log('Error connecting to DB:', err);
  } else {
    console.log('Database connected, response:', res.rows);
  }
});
// Serve the 'receipts' directory as static files
app.use('/receipts', express.static(path.join(__dirname, 'receipts')));

// Middleware
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

// Route to insert a new student record
app.post("/add-student", async (req, res) => {
  const {
    name,
    father,
    mother,
    schooling_class,
    mobile_number,
    address,
    paid,
    tutionfee_paid,
    fcc_class,
    fcc_id,
    skills,
    admission_date,
  } = req.body;

  const insertQuery = `
    INSERT INTO "New_Student_Admission"
    (name, father, mother, schooling_class, mobile_number, address, paid, tutionfee_paid, fcc_class, fcc_id, skills, admission_date)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING *;
  `;
  
  try {
    const result = await pool.query(insertQuery, [
      name,
      father,
      mother,
      schooling_class,
      mobile_number,
      address,
      paid,
      tutionfee_paid,
      fcc_class,
      fcc_id,
      skills,
      admission_date,
    ]);
    res.status(201).json(result.rows[0]); // Return response as JSON
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message }); // Send error as JSON
  }
});

app.get('/get-students', async (req, res) => {
  try {
    const query = 'SELECT * FROM "New_Student_Admission"';
    const result = await pool.query(query);

    // Format the admission_date to DD/MM/YY hh:mm AM/PM
    const formattedStudents = result.rows.map(student => ({
      ...student,
      admission_date: formatDate(student.admission_date) // Add formatted date
    }));

    res.json(formattedStudents); // Send the fetched and formatted data as JSON
  } catch (error) {
    console.error('Error fetching students:', error);
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

// Route to update student record
app.put("/update-student/:fcc_id", async (req, res) => {
  const { fcc_id } = req.params;
  const { skills, tutionfee_paid, payment_status } = req.body;

  // Query to update student data
  const updateQuery = `
    UPDATE "New_Student_Admission"
    SET skills = $1, tutionfee_paid = $2
    WHERE fcc_id = $3
    RETURNING *;
  `;

  // Query to update payment status
  const updatePaymentQuery = `
    UPDATE payments
    SET payment_status = $1
    WHERE fcc_id = $2
    RETURNING *;
  `;

  try {
    // Start a transaction
    await pool.query('BEGIN');

    // Update student data
    const studentUpdateResult = await pool.query(updateQuery, [skills, tutionfee_paid, fcc_id]);
    const updatedStudent = studentUpdateResult.rows[0];

    // Update payment status
    if (payment_status) {
      const paymentUpdateResult = await pool.query(updatePaymentQuery, [payment_status, fcc_id]);
      const updatedPayment = paymentUpdateResult.rows[0];
    }

    // Commit transaction
    await pool.query('COMMIT');

    res.status(200).json({ message: 'Student and payment data updated successfully!', student: updatedStudent });

  } catch (err) {
    // Rollback transaction in case of error
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});



// Helper function to format date
const formatDate = (date) => {
  const d = new Date(date);
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const hours12 = hours % 12;
  const minutesFormatted = minutes < 10 ? '0' + minutes : minutes;
  const day = d.getDate().toString().padStart(2, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const year = d.getFullYear().toString().slice(2);

  return `${day}/${month}/${year} ${hours12}:${minutesFormatted} ${ampm}`;
};


// Route to insert a new student record

// Validate FCC ID format
const validateFccId = (fccId) => {
  const regex = /^\d{4}200024$|^XXXX200024$/;
  return regex.test(fccId);
};

// API to update or create student data and log attendance
app.post("/api/update-student", async (req, res) => {
  const { fcc_id, ctc, ctg, task_completed, forceUpdate } = req.body;

  if (!fcc_id) {
    return res.status(400).json({ error: "FCC_ID is required" });
  }

  try {
    // Check if the student already exists in the `students` table
    const checkStudentQuery = "SELECT * FROM students WHERE fcc_id = $1";
    const result = await pool.query(checkStudentQuery, [fcc_id]);

    let ctcUpdated = false;

    if (result.rowCount > 0) {
      // Check if CTC is within 30 hours
      const student = result.rows[0];
      const currentTime = new Date();
      const ctcTime = new Date(student.ctc_time);
      const timeDiff = (currentTime - ctcTime) / (1000 * 60 * 60); // time difference in hours

      if (timeDiff > 30 && !forceUpdate) {
        // If CTC is older than 30 hours, don't update and return error
        return res.status(400).json({ message: "CTC is more than 30 hours old. Update not allowed!" });
      }

      // Update the CTC, CTG, and task completed fields
      const updateStudentQuery = `
        UPDATE students 
        SET ctc_time = CASE WHEN $1 THEN NOW() ELSE ctc_time END,
            ctg_time = CASE WHEN $2 THEN NOW() ELSE ctg_time END,
            task_completed = $3
        WHERE fcc_id = $4;
      `;
      await pool.query(updateStudentQuery, [ctc, ctg, task_completed, fcc_id]);

      ctcUpdated = true;
    } else {
      // Insert a new student record
      const insertStudentQuery = `
        INSERT INTO students (fcc_id, ctc_time, ctg_time, task_completed)
        VALUES ($1, CASE WHEN $2 THEN NOW() ELSE NULL END, CASE WHEN $3 THEN NOW() ELSE NULL END, $4);
      `;
      await pool.query(insertStudentQuery, [fcc_id, ctc, ctg, task_completed]);

      ctcUpdated = true;
    }

    // Log attendance
    const logAttendanceQuery = `
      INSERT INTO attendance_log (fcc_id, ctc_time, ctg_time, task_completed, log_date)
      VALUES ($1, CASE WHEN $2 THEN NOW() ELSE NULL END, CASE WHEN $3 THEN NOW() ELSE NULL END, $4, CURRENT_DATE)
      ON CONFLICT (fcc_id, log_date)
      DO UPDATE SET
        ctc_time = CASE WHEN $2 THEN NOW() ELSE attendance_log.ctc_time END,
        ctg_time = CASE WHEN $3 THEN NOW() ELSE attendance_log.ctg_time END,
        task_completed = $4;
    `;
    await pool.query(logAttendanceQuery, [fcc_id, ctc, ctg, task_completed]);

    if (ctcUpdated) {
      res.status(200).json({ message: "Student and attendance log updated successfully.", ctcUpdated: true });
    } else {
      res.status(200).json({ message: "Student and attendance log inserted successfully.", ctcUpdated: false });
    }
  } catch (error) {
    console.error("Error updating or creating student and logging attendance:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

// Upload data


// Multer Configuration
const storage = multer.memoryStorage(); // Store file in memory as a buffer
const upload = multer({ storage });

// Endpoint to upload file
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const { originalname, mimetype, buffer } = req.file;
    const { description } = req.body;

    // Insert file data into the PostgreSQL database, including the uploaded_at field
    const query = `
      INSERT INTO files (filename, filetype, filedata, description, uploaded_at) 
      VALUES ($1, $2, $3, $4, NOW()) RETURNING *`;
    const result = await pool.query(query, [originalname, mimetype, buffer, description]);

    res.status(200).json({ message: "File uploaded successfully", file: result.rows[0] });
  } catch (error) {
    console.error("Error uploading file:", error);
    res.status(500).json({ message: "Error uploading file", error: error.message });
  }
});

// Endpoint to fetch files with optional filters
app.get("/files", async (req, res) => {
  try {
    const { startDate, endDate, search } = req.query;
    let query = `SELECT id, filename, filetype, description, uploaded_at FROM files`;
    const conditions = [];
    const params = [];

    if (startDate) {
      conditions.push(`uploaded_at >= $${params.length + 1}`);
      params.push(startDate);
    }
    if (endDate) {
      conditions.push(`uploaded_at <= $${params.length + 1}`);
      params.push(endDate);
    }
    if (search) {
      conditions.push(`(filename ILIKE '%' || $${params.length + 1} || '%' OR description ILIKE '%' || $${params.length + 1} || '%')`);
      params.push(search);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(" AND ")}`;
    }

    query += " ORDER BY uploaded_at DESC";

    const result = await pool.query(query, params);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching files:", error);
    res.status(500).json({ message: "Error fetching files" });
  }
});


// Route to download a file
app.get('/files/download/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const query = 'SELECT * FROM files WHERE id = $1';
    const result = await pool.query(query, [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'File not found' });
    }

    const file = result.rows[0];

    // Set the response headers for downloading
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Content-Type', file.filetype);

    // Send the file buffer as the response
    res.send(file.filedata);
  } catch (error) {
    console.error("Error downloading file:", error);
    res.status(500).json({ message: 'Error downloading file' });
  }
});


app.post("/api/payments", async (req, res) => {
  const {
    fcc_id,
    amount,
    payment_method,
    payment_status,
    student_name,
    monthly_cycle_days,
  } = req.body;

  try {
    const taxRate = 0.18; // 18% GST rate
    const numericAmount = parseFloat(amount); // Ensure amount is a number
    if (isNaN(numericAmount)) {
      throw new Error("Invalid amount provided");
    }
    const taxAmount = numericAmount * taxRate;
    const grandTotal = numericAmount + taxAmount;

    // Insert payment data into the 'payments' table
    const paymentResult = await pool.query(
      `INSERT INTO payments (fcc_id, amount, payment_method, payment_status, student_name, monthly_cycle_days) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [fcc_id, grandTotal, payment_method, payment_status, student_name, monthly_cycle_days]
    );

    const payment = paymentResult.rows[0];
    const receiptDir = path.join(__dirname, "receipts");

    // Ensure the 'receipts' directory exists
    if (!fs.existsSync(receiptDir)) {
      fs.mkdirSync(receiptDir);
    }

    const receiptPath = path.join(receiptDir, `receipt_${payment.id}.pdf`);
    const doc = new PDFDocument({ margin: 50 });

    // Stream the PDF to file
    doc.pipe(fs.createWriteStream(receiptPath));

   // Outer Border
doc.lineWidth(2).rect(10, 10, doc.page.width - 20, doc.page.height - 20).stroke("#1E90FF");

// Header Section
const imageWidth = 70; // Width of the logo image
const marginRight = 40; // Right margin from the edge of the page
const rightX = doc.page.width - imageWidth - marginRight; // Calculate X position for right alignment

// Check if the logo file exists before loading it
if (fs.existsSync(logoPath)) {
  const imageWidth = 70; // Width of the logo image
  const marginRight = 40; // Right margin from the edge of the page
  const rightX = doc.page.width - imageWidth - marginRight; // Calculate X position for right alignment

  doc.image(logoPath, {
    fit: [imageWidth, 70],
    align: "right",
    valign: "top",
    x: rightX,
    y: doc.y,
  });
} else {
  console.error("Logo file not found:", logoPath);
}
doc.moveDown(0.5);
doc.moveDown(0.5);
doc
  .fontSize(18)
  .font("Helvetica-Bold")
  .fillColor("#1E90FF")
  .text("FCC The Gurukul", { align: "left" });
doc
  .fontSize(10)
  .font("Helvetica")
  .fillColor("black")
  .text("Motisabad Mugaon, Buxar, Bihar – 802126", { align: "left" });
doc.text("Contact: 9135365331 | Email: fccthegurukul@gmail.com", { align: "left" });
doc.moveDown(2);

// Receipt Title
doc
  .fontSize(22)
  .font("Helvetica-Bold")
  .fillColor("#4CAF50")
  .text("Fee Payment Receipt", { align: "center" });
doc.moveDown(0.5);
doc
  .fontSize(12)
  .font("Helvetica")
  .fillColor("black")
  .text("Thank you for your payment!", { align: "center" });
doc.moveDown(1.5);

// Section: Student Details
doc
  .fontSize(16)
  .font("Helvetica-Bold")
  .fillColor("#1E90FF")
  .text("Student Details:", { underline: true });
doc.moveDown(0.5);
doc
  .fontSize(12)
  .font("Helvetica")
  .fillColor("black")
  .text(`Student Name: ${payment.student_name}`, { align: "left" });
  doc.moveDown(0.5);
doc.text(`FCC ID: ${payment.fcc_id}`, { align: "left" });
doc.moveDown(1);

// Section: Payment Details
doc
  .fontSize(16)
  .font("Helvetica-Bold")
  .fillColor("#1E90FF")
  .text("Payment Details:", { underline: true });
doc.moveDown(0.5);
doc
  .fontSize(12)
  .font("Helvetica")
  .fillColor("black")
  .text(`Base Amount: ${numericAmount.toFixed(2)}`, { align: "left" });
  doc.moveDown(0.5);
doc.text(`GST (18%): ${taxAmount.toFixed(2)}`, { align: "left" });
doc.moveDown(0.5);
// Add Separator Line
doc.lineWidth(1).moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).stroke("#E0E0E0");
doc.moveDown(0.5);

doc.text(`Total Amount: ${grandTotal.toFixed(2)}`, { align: "left" });
doc.moveDown(0.5);
// Add Separator Line
doc.lineWidth(1).moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).stroke("#E0E0E0");
doc.moveDown(1);

doc.text(`Payment Method: ${payment.payment_method}`, { align: "left" });
doc.moveDown(0.5);
doc.text(`Payment Status: ${payment.payment_status}`, { align: "left" });
doc.moveDown(0.5);
doc.text(`Monthly Cycle Days: ${payment.monthly_cycle_days.join(", ")}`, { align: "left" });
doc.moveDown(0.5);
doc.text(`Payment Date: ${new Date(payment.payment_date).toLocaleString()}`, { align: "left" });
doc.moveDown(0.5);
doc.text(`Payment Receipt Code: #${payment.id}`, { align: "left", fillColor: "#E0E0E0" });
doc.moveDown(0.5);

// Add Separator Line
doc.lineWidth(1).moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).stroke("#E0E0E0");
doc.moveDown(1.5);

// QR Code Section
doc
  .fontSize(14)
  .font("Helvetica-Bold")
  .fillColor("#1E90FF")
  .text( `QR code ko scan karke ${payment.student_name}, ke pdhai bare me sabkuchh jane`, { align: "center" });
doc.moveDown(0.5);

const qrPath = path.join(receiptDir, `qr_${payment.id}.png`);
await QRCode.toFile(qrPath, `https://fccthegurukul.in/student/${payment.fcc_id}`);

// Center the QR Code
const qrWidth = 100; // Width of the QR code
const centerX = (doc.page.width - qrWidth) / 2; // Calculate X position for centering
doc.image(qrPath, centerX, doc.y, { width: qrWidth }); // Use calculated centerX and current Y position

doc.moveDown(1); // Move down after QR code


doc.moveDown(5);
// Footer Section
doc.lineWidth(0.5).moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).stroke("#E0E0E0");

doc.moveDown(1);
doc
  .fontSize(10)
  .font("Helvetica")
  .fillColor("gray")
  .text("This receipt is system-generated and does not require a signature.", { align: "center" });

doc
  .fontSize(10)
  .font("Helvetica")
  .fillColor("gray")
  .text("GST is included in fees but is not paid to the government due to low turnover.", { align: "center" });

doc
  .fontSize(10)
  .font("Helvetica")
  .fillColor("gray")
  .text("FCC The Gurukul © 2025. All rights reserved | www.fccthegurukul.in", { align: "center" });

  // Add Footer Image
const footerImgPath = "C:/Users/FCC The Gurukul/My Projects/fcc-home-webapp/src/assets/footerimg.png";
const footerImageHeight = 100;
const footerYPosition = doc.page.height - footerImageHeight - 20;

doc.image(footerImgPath, {
  fit: [doc.page.width - 100, footerImageHeight],
  align: "center",
  valign: "bottom",
  y: footerYPosition,
});

// Finalize the PDF
doc.end();

    // Insert receipt details into the 'receipts' table
    await pool.query(
      `INSERT INTO receipts (payment_id, student_name, fcc_id, base_amount, gst, grand_total, payment_method, payment_status, monthly_cycle_days, payment_date, receipt_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        payment.id,
        payment.student_name,
        payment.fcc_id,
        numericAmount,
        taxAmount,
        grandTotal,
        payment.payment_method,
        payment.payment_status,
        payment.monthly_cycle_days.join(", "),
        new Date(payment.payment_date),
        `receipts/receipt_${payment.id}.pdf`,
      ]
    );

    res.status(201).json({
      message: "Payment added successfully",
      receipt: `receipts/receipt_${payment.id}.pdf`,
    });
  } catch (err) {
    console.error("Error inserting payment:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/payments", async (req, res) => {
  try {
    const { fcc_id, payment_status, payment_method, startDate, endDate, monthly_cycle_days } = req.query;
    let query = `SELECT * FROM payments`;
    const conditions = [];
    const params = [];

    if (fcc_id) {
      conditions.push(`fcc_id = $${params.length + 1}`);
      params.push(fcc_id);
    }

    if (payment_status) {
      conditions.push(`payment_status = $${params.length + 1}`);
      params.push(payment_status);
    }

    if (payment_method) {
      conditions.push(`payment_method = $${params.length + 1}`);
      params.push(payment_method);
    }

    if (startDate) {
      conditions.push(`payment_date >= $${params.length + 1}`);
      params.push(startDate);
    }

    if (endDate) {
      conditions.push(`payment_date <= $${params.length + 1}`);
      params.push(endDate);
    }

    if (monthly_cycle_days) {
      const cycleDaysArray = monthly_cycle_days.split(',').map(day => parseInt(day.trim(), 10));
      conditions.push(`monthly_cycle_days && $${params.length + 1}::int[]`);
      params.push(cycleDaysArray);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(" AND ")}`;
    }

    query += " ORDER BY payment_date DESC";

    const result = await pool.query(query, params);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error fetching payments:", err);
    res.status(500).json({ error: err.message });
  }
});


const studentPhotos = {
  "4949200024": "https://firebasestorage.googleapis.com/v0/b/sarkari-result-23f65.appspot.com/o/profile_images%2FIMG_20241112_150831_462.jpg?alt=media&token=e75bd57c-f944-4061-94e7-381b15a519f1",
  "9631200024": "https://firebasestorage.googleapis.com/v0/b/sarkari-result-23f65.appspot.com/o/profile_images%2FZRIUJKZxEGfNRtkwTy2DfkWAL4s2?alt=media&token=9cd5e3fe-130e-4623-9299-7b5c88f9d519",
  "1234567890": "https://firebasestorage.googleapis.com/v0/b/sarkari-result-23f65.appspot.com/o/profile_images%2Fprofile-pic.png?alt=media&token=fe4c6d0c-73a5-44ed-8d4f-f8ac9b18dab7"
};

// Route to fetch student profile by FCC ID
app.get("/get-student-profile/:fcc_id", async (req, res) => {
  const { fcc_id } = req.params;

  try {
    const query = 'SELECT * FROM "New_Student_Admission" WHERE fcc_id = $1';
    const result = await pool.query(query, [fcc_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Student not found" });
    }

    const student = result.rows[0];
    student.photo_url = studentPhotos[fcc_id] || null; // Assign photo if available

    res.json(student);
  } catch (error) {
    console.error("Error fetching student:", error);
    res.status(500).json({ error: "Failed to fetch student data" });
  }
});


app.get('/get-student-skills/:fcc_id', async (req, res) => {
  const { fcc_id } = req.params;

  try {
    const query = `
      SELECT
        skill_topic,
        skill_level,
        skill_description,
        skill_image_url,
        status,
        skill_log
      FROM student_skills
      WHERE fcc_id = $1
    `;
    const result = await pool.query(query, [fcc_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No skills found for this student' });
    }

    // Add defaults if missing
    const skills = result.rows.map(skill => ({
      ...skill,
      skill_level: skill.skill_level || 'Unknown',  // default if missing
      status: skill.status || 'Not Specified',     // default if missing
      skill_description: skill.skill_description || 'No description available', // default if missing
    }));

    res.json(skills); // Send all fetched data
  } catch (error) {
    console.error('Error fetching skills:', error);
    res.status(500).json({ error: 'Failed to fetch student skills' });
  }
});



// Route to fetch CTC/CTG data and logs by FCC ID
app.get("/get-ctc-ctg/:fcc_id", async (req, res) => {
  const { fcc_id } = req.params;

  try {
    // Query to fetch student data
    const studentQuery = `
      SELECT fcc_id, ctc_time, ctg_time, task_completed
      FROM students
      WHERE fcc_id = $1;
    `;

    // Query to fetch logs
    const logsQuery = `
      SELECT fcc_id, ctc_time, ctg_time, task_completed, log_date
      FROM attendance_log
      WHERE fcc_id = $1
      ORDER BY log_date DESC; -- Sort logs by most recent date
    `;

    // Execute queries
    const studentResult = await pool.query(studentQuery, [fcc_id]);
    const logsResult = await pool.query(logsQuery, [fcc_id]);

    // Check if student exists
    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: "Student not found" });
    }

    // Return student and log data
    res.json({
      student: studentResult.rows[0], // Single student entry
      logs: logsResult.rows,          // Array of log entries
    });
  } catch (error) {
    console.error("Error fetching CTC/CTG data and logs:", error);
    res.status(500).json({ error: "Failed to fetch CTC/CTG data and logs" });
  }
});


// API एंडपॉइंट टॉपिक के आधार पर क्विज़ प्रश्न प्राप्त करने के लिए
app.get('/get-quiz-by-topic/:skillTopic', async (req, res) => {
  const { skillTopic } = req.params;
  try {
      const query = 'SELECT * FROM quizzes WHERE skill_topic = $1';
      const values = [skillTopic];
      const result = await pool.query(query, values);
      res.json(result.rows); // प्रश्नों को JSON प्रतिक्रिया के रूप में भेजें
  } catch (error) {
      console.error('क्विज़ प्रश्न प्राप्त करने में त्रुटि:', error);
      res.status(500).json({ error: 'क्विज़ प्रश्न प्राप्त करने में विफल' });
  }
});

// नया API एंडपॉइंट क्विज़ सेशन शुरू करने के लिए
app.post('/start-quiz-session', async (req, res) => {
  const { fccId, skillTopic, totalQuestions } = req.body;

  try {
      const query = 'INSERT INTO quiz_sessions (fcc_id, skill_topic, total_questions, score) VALUES ($1, $2, $3, $4) RETURNING session_id, start_time';
      const values = [fccId, skillTopic, totalQuestions, 0]; // Added score: 0 to the values and query
      const result = await pool.query(query, values);

      const session = result.rows[0];
      res.json({ sessionId: session.session_id, startTime: session.start_time });
  } catch (error) {
      console.error('क्विज़ सेशन शुरू करने में त्रुटि:', error);
      res.status(500).json({ error: 'क्विज़ सेशन शुरू करने में विफल' });
  }
});

// अपडेट किया गया API एंडपॉइंट क्विज़ प्रयास सबमिट करने के लिए
app.post('/submit-quiz-attempt', async (req, res) => {
  const { sessionId, fccId, skillTopic, quizAnswers } = req.body; // अब sessionId प्राप्त करें // fccId is available here
  let score = 0;

  try {
      for (const qa of quizAnswers) {
          const { question_id, user_answer } = qa;

          // प्रश्न ID से सही उत्तर प्राप्त करें
          const questionQuery = 'SELECT correct_answer FROM quizzes WHERE quiz_id = $1';
          const questionValues = [question_id];
          try {
              const questionResult = await pool.query(questionQuery, questionValues);

              if (questionResult.rows.length > 0) {
                  const correctAnswer = questionResult.rows[0].correct_answer;
                  const isCorrect = user_answer === correctAnswer;

                  // यदि उत्तर सही है तो स्कोर बढ़ाएँ
                  if (isCorrect) {
                      score++;
                  }

                  // प्रयास डेटा डेटाबेस में स्टोर करें, अब session_id डालें, **include fccId here**
                  const attemptQuery = 'INSERT INTO quiz_attempts (session_id, question_id, user_answer, is_correct, fcc_id) VALUES ($1, $2, $3, $4, $5)'; // Added fcc_id to columns
                  const attemptValues = [sessionId, question_id, user_answer, isCorrect, fccId]; // Added fccId to values
                  try {
                      await pool.query(attemptQuery, attemptValues);
                  } catch (attemptError) {
                      console.error('प्रयास डेटा डालने में त्रुटि:', attemptError);
                      console.error('प्रयास डेटा डालने में त्रुटि - क्वेरी:', attemptQuery, attemptValues);
                      throw attemptError;
                  }
              } else {
                  console.warn(`प्रश्न ID ${question_id} नहीं मिला`);
              }
          } catch (questionError) {
              console.error('सही उत्तर प्राप्त करने में त्रुटि:', questionError);
              console.error('सही उत्तर प्राप्त करने में त्रुटि - क्वेरी:', questionQuery, questionValues);
              throw questionError;
          }
      }

      // क्विज़ सेशन रिकॉर्ड अपडेट करें session score, end_time, और duration के साथ
      const updateSessionQuery = 'UPDATE quiz_sessions SET score = $1, end_time = NOW(), duration = end_time - start_time WHERE session_id = $2 RETURNING end_time, duration';
      const updateSessionValues = [score, sessionId];
      try {
          const updateSessionResult = await pool.query(updateSessionQuery, updateSessionValues);
          const sessionUpdate = updateSessionResult.rows[0];
          res.json({ score: score, endTime: sessionUpdate.end_time, duration: sessionUpdate.duration, message: 'क्विज़ सबमिट हो गया!' });
      } catch (updateSessionError) {
          console.error('क्विज़ सेशन अपडेट करने में त्रुटि:', updateSessionError);
          console.error('क्विज़ सेशन अपडेट करने में त्रुटि - क्वेरी:', updateSessionQuery, updateSessionValues);
          throw updateSessionError;
      }

  } catch (error) {
      console.error('क्विज़ प्रयास सबमिट करने में त्रुटि:', error);
      res.status(500).json({ error: 'क्विज़ सबमिट करने में विफल' });
  }
});


// Endpoint to get all classes
app.get('/get-classes', async (req, res) => {
  try {
      // Query to fetch distinct class names from Leaderboard_Scoring_Task table
      const classesResult = await pool.query(
          `SELECT DISTINCT class FROM Leaderboard_Scoring_Task WHERE class IS NOT NULL AND class != '' ORDER BY class`
      );

      // Extract class names from the result rows
      const classNames = classesResult.rows.map(row => row.class);

      res.json({ classes: classNames }); // Send the class names as JSON response
  } catch (error) {
      console.error('Error fetching classes:', error);
      res.status(500).json({ error: 'Server error fetching classes' });
  }
});


// Endpoint to fetch personalized leaderboard data for a student (MODIFIED to fetch fcc_class from Leaderboard)
// Endpoint to fetch personalized leaderboard data for a student (MODIFIED to fetch fcc_class from Leaderboard AND include start_time and end_time for tasks)
app.get('/leaderboard/:fccId', async (req, res) => {
  const { fccId } = req.params;
  const { leaderboardClassFilter } = req.query; // Get class filter from query params

  try {
      // 1. Fetch student profile to get fcc_class (Optional - keep for consistency or fallback)
      const studentProfileResponse = await fetch(`http://localhost:${port}/get-student-profile/${fccId}`);
      if (!studentProfileResponse.ok) {
          console.error('Error fetching student profile:', studentProfileResponse.statusText);
          return res.status(500).json({ error: 'Student profile fetch failed' });
      }
      const studentProfileData = await studentProfileResponse.json();
      const studentClass = studentProfileData?.fcc_class; // Get numerical fcc_class from student profile

      if (!studentClass) {
          console.error('Student class not found for FCC ID:', fccId);
          return res.status(400).json({ error: 'Student class not found' });
      }

      // 2. Get leaderboard data for all students (or top N) -  NOW FETCHING fcc_class from Leaderboard
      let leaderboardQuery = `SELECT * FROM Leaderboard`;
      let leaderboardParams = [];

      if (leaderboardClassFilter && leaderboardClassFilter !== 'ALL') {
          leaderboardQuery += ` WHERE fcc_class = $1`;
          leaderboardParams = [leaderboardClassFilter];
      }

      leaderboardQuery += ` ORDER BY total_score DESC LIMIT 100`; // Always apply limit

      const leaderboardResult = await pool.query(leaderboardQuery, leaderboardParams);

      // 3. Get personalized scoring tasks and task history for the given FCC ID (MODIFIED QUERY TO INCLUDE start_time and end_time)
      const tasksResult = await pool.query(
          `SELECT st.task_id, st.task_name, st.description, st.max_score, st.start_time, st.end_time, /* ADDED start_time, end_time */
                  COALESCE(stl.score_earned, 0) as score_earned, stl.status, stl.completed_at
             FROM Leaderboard_Scoring_Task st
             LEFT JOIN Scoring_Task_Log stl
                ON st.task_id = stl.task_id AND stl.student_fcc_id = $1
             WHERE st.class = $2::VARCHAR  -- Filter tasks by student's class
             ORDER BY st.task_id`,
          [fccId, studentClass] // Pass studentClass for task filtering
      );

      // 4. Optionally, fetch student's leaderboard record (as before)
      const studentRecord = await pool.query(
          `SELECT * FROM Leaderboard WHERE student_fcc_id = $1`,
          [fccId]
      );

      res.json({
          leaderboard: leaderboardResult.rows,
          tasks: tasksResult.rows,
          student: studentRecord.rows[0] || null,
      });
  } catch (err) {
      console.error('Error fetching leaderboard data:', err);
      res.status(500).json({ error: 'Server error fetching leaderboard data' });
  }
});

// Endpoint to mark a task as completed and update the score
app.post('/complete-task', async (req, res) => {
  const { fccId, taskId, scoreEarned } = req.body;
  try {
    // 1. Insert a record in Scoring_Task_Log
    const insertResult = await pool.query(
      `INSERT INTO Scoring_Task_Log (student_fcc_id, task_id, score_earned, status, completed_at)
       VALUES ($1, $2, $3, 'COMPLETED', NOW())
       RETURNING *`,
      [fccId, taskId, scoreEarned]
    );

    // 2. Update the student's total score in Leaderboard table (Add the new score)
    const updateResult = await pool.query(
      `UPDATE Leaderboard
       SET total_score = total_score + $1, last_updated = NOW()
       WHERE student_fcc_id = $2
       RETURNING *`,
      [scoreEarned, fccId]
    );

    // 3. Log the update in Leaderboard_Log
    await pool.query(
      `INSERT INTO Leaderboard_Log (leaderboard_id, action, description)
       VALUES ($1, 'UPDATE', 'Score updated by task completion')`,
      [updateResult.rows[0].id]
    );

    res.json({
      message: 'Task completed and score updated successfully',
      taskLog: insertResult.rows[0],
      updatedLeaderboard: updateResult.rows[0],
    });
  } catch (err) {
    console.error('Error completing task:', err);
    res.status(500).json({ error: 'Server error while completing task' });
  }
});

// app.post('/api/chat', async (req, res) => {
//   const userMessage = req.body.message;

//   if (!userMessage) {
//       return res.status(400).json({ error: 'Message is required' });
//   }

//   try {
//       const result = await model.generateContent(userMessage);
//       const responseText = result.response.text();
//       res.json({ response: responseText });
//   } catch (error) {
//       console.error("Gemini API error:", error);
//       res.status(500).json({ error: 'Failed to get response from Gemini API' });
//   }
// });


app.post('/api/chat', async (req, res) => {
  const userMessage = req.body.message;
  const selectedModel = req.body.model;

  if (!userMessage) {
      return res.status(400).json({ error: 'Message is required' });
  }

  try {
      let responseText = "";
      if (selectedModel === 'deepseek') {
          // DeepSeek via OpenRouter
          const openRouterApiKey = "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"; // **OpenRouter API key यहाँ डालें**
          const deepseekResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: {
                  "Authorization": `Bearer ${openRouterApiKey}`,
                  "Content-Type": "application/json"
              },
              body: JSON.stringify({
                  "model": "deepseek/deepseek-r1:free",
                  "messages": [
                      {
                          "role": "user",
                          "content": userMessage
                      }
                  ]
              })
          });

          if (!deepseekResponse.ok) {
              const errorDetails = await deepseekResponse.json();
              console.error("OpenRouter/DeepSeek API error:", errorDetails);
              throw new Error(`DeepSeek API request failed with status ${deepseekResponse.status}: ${errorDetails.error ? errorDetails.error.message : deepseekResponse.statusText}`);
          }

          const deepseekData = await deepseekResponse.json();
          responseText = deepseekData.choices[0].message.content;

      } else  if (selectedModel === 'gemini' || !selectedModel) {
          // Google Gemini (डिफ़ॉल्ट)
          const geminiResult = await geminiModel.generateContent(userMessage);
          responseText = geminiResult.response.text();
      } else {
          return res.status(400).json({ error: 'Invalid model selected' });
      }

      res.json({ response: responseText });

  } catch (error) {
      console.error("API error:", error);
      res.status(500).json({ error: 'Failed to get response from AI model' });
  }
});

// FCC ID के आधार पर अपडेटेड टेबल से फीस विवरण प्राप्त करने वाला API endpoint
app.get("/get-tuition-fee-details/:fcc_id", async (req, res) => {
  const { fcc_id } = req.params;
  try {
    const queryText = `
      SELECT total_fee,
             fee_paid,
             fee_remaining,
             due_date,
             offer_price,
             offer_valid_till,
             class
      FROM tuition_fee_details
      WHERE fcc_id = $1
    `;
    const { rows } = await pool.query(queryText, [fcc_id]);
    if (rows.length === 0) {
      return res
        .status(404)
        .json({ error: "उस FCC ID के लिए कोई फीस विवरण नहीं मिला" });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error("फीस विवरण प्राप्त करने में त्रुटि:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  
});