const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");


const app = express();
const server = http.createServer(app);


const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});


app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));


app.use(express.static(__dirname)); 


const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'Alumini_Student',
  password: '123456789', 
  port: 5433,
});


app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});



app.get('/users', async (req, res) => {
    const currentUserId = req.query.currentUserId;
    if (!currentUserId) {
        return res.status(400).json({ error: 'currentUserId is required' });
    }
    try {
        const result = await pool.query('SELECT user_id, username AS name, role FROM user_table WHERE user_id != $1', [currentUserId]);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

app.get('/messages/get/:sender_id/:receiver_id', async (req, res) => {
    try {
        const { sender_id, receiver_id } = req.params;
        const result = await pool.query(
            `SELECT * FROM message_table 
             WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
             ORDER BY timestamp ASC`,
            [sender_id, receiver_id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching messages:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/messages/send', async (req, res) => {
    try {
        const { sender_id, receiver_id, message_text } = req.body;
        const result = await pool.query(
            'INSERT INTO message_table (sender_id, receiver_id, message_text) VALUES ($1, $2, $3) RETURNING *',
            [sender_id, receiver_id, message_text]
        );
        const newMessage = result.rows[0];

        // Emit to sender and receiver rooms
        io.to(`user_${sender_id}`).emit('new_message', newMessage);
        io.to(`user_${receiver_id}`).emit('new_message', newMessage);
        
        res.status(201).json(newMessage);
    } catch (err)
 {
        console.error('Error sending message:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route   POST /register
 * @desc    Registers a new user
 * @note    Assumes you've added `age` and `profile_picture_url` to user_table
 */
app.post('/register', async (req, res) => {
  const { fullname, email, password, phone, role, studentData, alumniData } = req.body;

  if (!fullname || !email || !password || !role) {
    return res.status(400).json({ success: false, message: 'Please fill out all required fields.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userExists = await client.query('SELECT * FROM user_table WHERE email = $1', [email]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'User with this email already exists.' });
    }
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    
    // Add default profile picture URL
    const defaultProfilePic = 'https://placehold.co/150x150/3b82f6/FFFFFF?text=User';

    const newUserQuery = `
      INSERT INTO user_table (username, email, password_hash, role, phone_number, profile_picture_url)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING user_id
    `;
    const result = await client.query(newUserQuery, [fullname, email, hashedPassword, role, phone, defaultProfilePic]);
    const userId = result.rows[0].user_id;

    if (role === 'student' && studentData) {
      const { roll_number, department_id, admission_year, graduation_year, current_semester } = studentData;
      await client.query(`
        INSERT INTO student_table (user_id, roll_number, department_id, admission_year, graduation_year, current_semester)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [userId, roll_number, department_id, admission_year, graduation_year, current_semester]);
    } else if (role === 'alumni' && alumniData) {
      const { department_id, year_of_pass, current_job_title, company_name, location, linkedin_url, website_url } = alumniData;
      await client.query(`
        INSERT INTO alumini_table (user_id, department_id, year_of_pass, current_job_title, company_name, location, linkedin_url, website_url)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [userId, department_id, year_of_pass, current_job_title, company_name, location, linkedin_url, website_url]);
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, message: 'Registration successful!', userId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Registration error:', err);
    res.status(500).json({ success: false, message: 'An internal server error occurred.' });
  } finally {
    client.release();
  }
});

/**
 * @route   POST /login
 * @desc    Authenticates a user and returns role-specific ID
 */
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Please provide email and password.' });
    }
    try {
        const userResult = await pool.query(`SELECT * FROM user_table WHERE email = $1`, [email]);
        if (userResult.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid credentials. User not found.' });
        }
        
        const user = userResult.rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        
        if (!isMatch) {
             return res.status(401).json({ success: false, message: 'Invalid credentials. Please check your password.' });
        }

        let role_id = null;
        if (user.role === 'student') {
            const studentResult = await pool.query('SELECT student_id FROM student_table WHERE user_id = $1', [user.user_id]);
            if (studentResult.rows.length > 0) role_id = studentResult.rows[0].student_id;
        } else if (user.role === 'alumni') {
             const alumniResult = await pool.query('SELECT alumni_id FROM alumini_table WHERE user_id = $1', [user.user_id]);
             if (alumniResult.rows.length > 0) role_id = alumniResult.rows[0].alumni_id;
        }

        res.status(200).json({ 
            success: true, 
            message: 'Login successful!',
            user_id: user.user_id,
            username: user.username,
            role: user.role,
            role_id: role_id // This is the studentId or alumniId
        });

    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
});

// --- Search Route ---
app.get('/api/search-users', async (req, res) => {
    const { query, currentUserId } = req.query;
    if (!query || !currentUserId) {
        return res.status(400).json({ error: 'Search query and currentUserId are required.' });
    }
    try {
        const searchTerm = `%${query}%`;
        const result = await pool.query(
            `SELECT user_id, username, role, profile_picture_url
             FROM user_table
             WHERE username ILIKE $1
             AND user_id != $2
             ORDER BY username`,
            [searchTerm, currentUserId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error searching users:', err);
        res.status(500).json({ error: 'An internal server error occurred during search.' });
    }
});


// --- Socket.io Connection Logic ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    socket.on('join_chat', (userId) => {
        const roomName = `user_${userId}`;
        socket.join(roomName);
        console.log(`User with socket ID ${socket.id} joined room ${roomName}`);
    });
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

// --- Internship Routes (FIXED) ---

/**
 * @route   POST /api/internships
 * @desc    Post a new internship
 * @note    Assumes `position` and `requirements` columns exist in `internship_offer`
 */
app.post("/api/internships", async (req, res) => {
  const {
    alumni_id,
    title,
    description,
    company_name,
    location,
    duration,
    stipend,
    position,      // NEW
    requirements,  // NEW
  } = req.body;

  // Basic validation
  if (!alumni_id || !title || !company_name || !location) {
      return res.status(400).json({ error: "Missing required internship fields." });
  }

  try {
    const deadline = new Date(new Date().setMonth(new Date().getMonth() + 1)); // 1 month deadline

    const result = await pool.query(
      `INSERT INTO internship_offer 
        (alumni_id, title, description, company_name, location, duration, stipend, deadline, position, requirements)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [alumni_id, title, description, company_name, location, duration, stipend, deadline, position, requirements]
    );

    res.status(201).json({
      message: "Internship posted successfully",
      internship: result.rows[0],
    });
  } catch (err) {
    console.error("Error posting internship:", err);
    res.status(500).json({ error: "Failed to post internship" });
  }
});

/**
 * @route   GET /api/internships
 * @desc    Get all 'Open' internships for students
 * @note    Now selects `position` and `requirements`
 */
app.get("/api/internships", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
          i.internship_id AS id,
          i.title AS internshipName,
          i.description,
          i.requirements,      -- NEW
          i.position,          -- NEW
          i.company_name AS companyName,
          i.location,
          i.duration,
          i.stipend AS salary,
          i.posted_date AS postedDate,
          i.status,
          u.username AS granterName,
          u.profile_picture_url AS granterProfilePic
      FROM internship_offer i
      LEFT JOIN alumini_table a ON i.alumni_id = a.alumni_id
      LEFT JOIN user_table u ON a.user_id = u.user_id
      WHERE i.status = 'Open'
      ORDER BY i.posted_date DESC;
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ SQL Query Error in /api/internships:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get all internships posted by a specific alumni
app.get("/api/internships/alumni/:alumniId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT internship_id, title, company_name, location, duration, stipend, posted_date, status
       FROM internship_offer
       WHERE alumni_id = $1
       ORDER BY posted_date DESC`,
      [req.params.alumniId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching alumni internships:", err);
    res.status(500).json({ error: "Failed to load internships" });
  }
});

// --- Application Routes ---

// Update application status (for alumni)
app.put("/api/applications/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    await pool.query(
      "UPDATE internship_application SET application_status = $1 WHERE application_id = $2",
      [status, id]
    );
    res.json({ message: "Application status updated successfully" });
  } catch (err) {
    console.error("Error updating application status:", err);
    res.status(500).json({ error: "Failed to update application status" });
  }
});

// Apply for an internship (for student)
app.post("/api/internships/:id/apply", async (req, res) => {
  const internshipId = req.params.id;
  const { student_id, message } = req.body;
  if (!student_id) {
      return res.status(400).json({ message: "Student ID is required." });
  }
  try {
    const existing = await pool.query(
      `SELECT * FROM internship_application 
       WHERE internship_id = $1 AND student_id = $2`,
      [internshipId, student_id]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ message: "Already applied for this internship" });
    }
    await pool.query(
      `INSERT INTO internship_application (internship_id, student_id, message)
       VALUES ($1, $2, $3)`,
      [internshipId, student_id, message]
    );
    res.status(201).json({ message: "Application submitted successfully" });
  } catch (err) {
    console.error("Error applying:", err);
    res.status(500).json({ error: "Failed to apply for internship" });
  }
});

// Get all applications of a specific student
app.get("/api/applications/:studentId", async (req, res) => {
  const { studentId } = req.params;
  if (!studentId || studentId === "null" || studentId === "undefined") {
    return res.status(400).json({ error: "Invalid or missing student ID" });
  }
  try {
    const result = await pool.query(
      `SELECT a.application_id, a.applied_date, a.application_status, 
              i.title AS internship_title, i.company_name,
              i.internship_id
       FROM internship_application a
       JOIN internship_offer i ON a.internship_id = i.internship_id
       WHERE a.student_id = $1
       ORDER BY a.applied_date DESC`,
      [parseInt(studentId, 10)]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching applications:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});




/**
 * @route   GET /api/profile/:userId
 * @desc    Get public profile data for any user
 * @note    Assumes a `department` table exists with `department_id` and `department_name`
 * @FIX     Corrected the JOIN logic for department_table
 */
app.get('/api/profile/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        // FIXED QUERY: Uses COALESCE to correctly pick the department_id
        // from either student_table or alumini_table before joining.
        const query = `
            SELECT 
                u.user_id,
                u.username,
                u.email,
                u.phone_number,
                u.role,
                u.age,
                u.profile_picture_url,
                s.roll_number,
                s.admission_year,
                s.graduation_year,
                s.current_semester,
                a.year_of_pass,
                a.current_job_title,
                a.company_name,
                a.location,
                a.linkedin_url,
                a.website_url,
                d.department_name 
            FROM user_table u
            LEFT JOIN student_table s ON u.user_id = s.user_id
            LEFT JOIN alumini_table a ON u.user_id = a.user_id
            LEFT JOIN department_table d ON d.department_id = COALESCE(s.department_id, a.department_id)
            WHERE u.user_id = $1;
        `;
        const result = await pool.query(query, [userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching profile:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route   PUT /api/profile
 * @desc    Update the current user's profile
 * @FIX     Updated to handle null values for numeric fields
 */
app.put('/api/profile', async (req, res) => {
    const { 
        userId, username, phone, age, profile_picture_url, // user_table fields
        roll_number, admission_year, graduation_year, current_semester, // student_table fields
        year_of_pass, current_job_title, company_name, location, linkedin_url, website_url // alumini_table fields
    } = req.body;
    
    const role = req.body.role; // Need role to know which table to update

    if (!userId || !role) {
        return res.status(400).json({ error: 'User ID and role are required.' });
    }


    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Update user_table
        const userUpdateQuery = `
            UPDATE user_table 
            SET username = $1, phone_number = $2, age = $3, profile_picture_url = $4
            WHERE user_id = $5
            RETURNING *;
        `;
        const userResult = await client.query(userUpdateQuery, [username, phone, age, profile_picture_url, userId]);
        if (userResult.rows.length === 0) {
            throw new Error('User not found for update.');
        }

       
        if (role === 'student') {
            const studentUpdateQuery = `
                UPDATE student_table
                SET roll_number = $1, admission_year = $2, graduation_year = $3, current_semester = $4
                WHERE user_id = $5;
            `;
          
            await client.query(studentUpdateQuery, [roll_number, admission_year, graduation_year, current_semester, userId]);
        } else if (role === 'alumni') {
            const alumniUpdateQuery = `
                UPDATE alumini_table
                SET year_of_pass = $1, current_job_title = $2, company_name = $3, location = $4, linkedin_url = $5, website_url = $6
                WHERE user_id = $7;
            `;
            
            await client.query(alumniUpdateQuery, [year_of_pass, current_job_title, company_name, location, linkedin_url, website_url, userId]);
        }

        await client.query('COMMIT');
        res.status(200).json({ success: true, message: 'Profile updated successfully!', user: userResult.rows[0] });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error updating profile:', err);
       
        res.status(500).json({ success: false, message: `An internal server error occurred: ${err.message}` });
    } finally {
        client.release();
    }
});


// --- Server Start ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
