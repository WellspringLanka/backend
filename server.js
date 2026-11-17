require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs'); // <-- NEW: Added Encryption Library

const app = express();
const PORT = process.env.PORT || 5000;

// Strict CORS Configuration
const allowedOrigins = [
  'http://localhost:5173',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(express.json());

// Initialize Supabase with SERVICE_ROLE key
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Helper: Safely get next ID for legacy tables
async function getNextId(tableName) {
  const { data, error } = await supabase
    .from(tableName)
    .select('id')
    .order('id', { ascending: false })
    .limit(1);

  if (error) throw error;
  return data && data.length > 0 ? Number(data[0].id) + 1 : 1;
}

// ============================================================================
// ROUTE 1: Encrypted Doctor Portal Login
// ============================================================================
app.post('/api/doctor/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    // 1. Fetch the user by username
    const { data: doctor, error } = await supabase
      .from('doctors_master')
      .select('id, name, specialty, reg_number, username, password, flag')
      .eq('username', username.trim())
      .eq('flag', 1)
      .single();

    // If no user found or database error
    if (error || !doctor) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    // 2. Compare the typed password with the encrypted hash in the database
    const isMatch = await bcrypt.compare(password, doctor.password);

    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    // 3. Mark doctor as online
    await supabase
      .from('doctors_master')
      .update({ is_online: true })
      .eq('id', doctor.id);

    // Send data back without the password
    res.json({
      id: doctor.id,
      name: doctor.name,
      specialty: doctor.specialty,
      reg_number: doctor.reg_number,
      username: doctor.username
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// ROUTE 2: Get Active Waiting Queue for Today (Strictly Today + Auto-Cleanup)
// ============================================================================
app.get('/api/doctor/queue', async (req, res) => {
  try {
    // Get exact YYYY-MM-DD in Sri Lanka Time
    const todaySL = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Colombo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());

    // Futureproof Auto-Cleanup: Cancel any leftover flag=1 or flag=2 tickets from past dates
    await supabase
      .from('ticket_master')
      .update({ flag: 0 })
      .in('flag', [1, 2])
      .lt('channeling_date', todaySL);

    // Strictly fetch ONLY today's active waiting queue (flag = 1 AND channeling_date = todaySL)
    const { data: tickets, error: ticketErr } = await supabase
      .from('ticket_master')
      .select('*')
      .eq('flag', 1)
      .eq('channeling_date', todaySL)
      .order('id', { ascending: true })
      .limit(100);

    if (ticketErr) throw ticketErr;
    if (!tickets || tickets.length === 0) return res.json([]);

    const patientIds = [...new Set(tickets.map(t => t.patient_id).filter(Boolean))];
    const { data: patients, error: patErr } = await supabase
      .from('patients_master')
      .select('id, name, phone, birth_date, gender, married, common, reference, id_number, weight, height')
      .in('id', patientIds);

    if (patErr) throw patErr;

    const patientMap = {};
    (patients || []).forEach(p => { patientMap[p.id] = p; });

    const queue = tickets
      .map((t, idx) => ({
        ticket_id: t.id,
        daily_queue_no: idx + 1,
        ticket_number: t.number || idx + 1,
        channeling_date: t.channeling_date,
        insert_date: t.insert_date,
        patient: patientMap[t.patient_id] || null
      }))
      .filter(item => item.patient !== null);

    res.json(queue);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// ROUTE 3: Server-Side Advanced Paginated Patient Search
// ============================================================================
app.get('/api/patients/search', async (req, res) => {
  try {
    const { name, nic, phone, dob, page: pageQuery } = req.query;
    const page = parseInt(pageQuery || '1', 10);
    const limit = 15;
    const offset = (page - 1) * limit;

    // If no search parameters provided, return empty
    if (!name && !nic && !phone && !dob) {
      return res.json({ data: [], page, hasMore: false });
    }

    let queryBuilder = supabase
      .from('patients_master')
      .select('id, name, reference, common, id_number, phone, birth_date, gender, weight, height, last_visit_date');

    // 1. Standard Filters
    if (name) queryBuilder = queryBuilder.ilike('name', `%${name.trim()}%`);
    if (nic) queryBuilder = queryBuilder.ilike('id_number', `%${nic.trim()}%`);

    // 2. Bulletproof Phone Search
    if (phone) {
      let cleanPhone = phone.trim();
      let noZero = cleanPhone.startsWith('0') ? cleanPhone.substring(1) : cleanPhone;
      let withZero = cleanPhone.startsWith('0') ? cleanPhone : '0' + cleanPhone;
      
      if (noZero.length > 0) {
        queryBuilder = queryBuilder.or(`phone.ilike.%${cleanPhone}%,phone.ilike.%${noZero}%,phone.ilike.%${withZero}%`);
      }
    }

    // 3. Smart Date of Birth Search (YYYY, YYYY-MM, or YYYY-MM-DD)
    if (dob) {
      // Standardize slashes to dashes
      let cleanDob = dob.trim().replace(/\//g, '-');
      
      if (/^\d{4}$/.test(cleanDob)) {
        // Just a Year (e.g., "2005") -> Jan 1 to Dec 31
        queryBuilder = queryBuilder.gte('birth_date', `${cleanDob}-01-01`).lte('birth_date', `${cleanDob}-12-31`);
        
      } else if (/^\d{4}-\d{2}$/.test(cleanDob)) {
        // Year and Month (e.g., "2005-12" or "2005/12")
        const [year, month] = cleanDob.split('-');
        
        // JS Trick: Day 0 of the next month returns the exact last day of the current month (28, 30, or 31)
        const lastDay = new Date(year, month, 0).getDate(); 
        
        queryBuilder = queryBuilder.gte('birth_date', `${cleanDob}-01`).lte('birth_date', `${cleanDob}-${lastDay}`);
        
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(cleanDob)) {
        // Exact Date (e.g., "1993-05-14")
        queryBuilder = queryBuilder.eq('birth_date', cleanDob);
      }
    }

    const { data, error } = await queryBuilder
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    res.json({
      data: data || [],
      page,
      hasMore: (data || []).length === limit
    });
  } catch (err) {
    console.error("Search Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
// ============================================================================
// ROUTE 4: Direct Walk-In Patient Registration
// ============================================================================
app.post('/api/patients', async (req, res) => {
  try {
    const { name, birth_date, phone, id_number, gender, married, common, weight, height } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Patient name is required' });
    }

    const nextPatientId = await getNextId('patients_master');
    const now = new Date().toISOString();

    const newPatient = {
      id: nextPatientId,
      name: name.trim(),
      birth_date: birth_date || null,
      phone: phone || '',
      id_number: id_number || '',
      reference: '',
      common: common || '',
      gender: gender ? Number(gender) : 1,
      married: married ? Number(married) : 0,
      weight: weight ? Number(weight) : 0,
      height: height ? Number(height) : 0,
      registration_date: now,
      last_visit_date: now,
      insert_by_id: 1,
      flag: 1
    };

    const { data, error } = await supabase
      .from('patients_master')
      .insert([newPatient])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ============================================================================
// ROUTE 5: Load Full Patient Consultation Profile & History
// ============================================================================
app.get('/api/patients/:id/consultation', async (req, res) => {
  try {
    const patientId = Number(req.params.id);

    const { data: patient, error: patErr } = await supabase
      .from('patients_master')
      .select('*')
      .eq('id', patientId)
      .single();

    if (patErr) throw patErr;

    const { data: tickets, error: tickErr } = await supabase
      .from('ticket_master')
      .select('id, number, channeling_date, insert_date, flag')
      .eq('patient_id', patientId)
      .order('id', { ascending: false });

    if (tickErr) throw tickErr;

    const ticketIds = (tickets || []).map(t => t.id);
    const ticketDateMap = {};
    (tickets || []).forEach(t => {
      ticketDateMap[t.id] = t.channeling_date || t.insert_date;
    });

    let allergiesAndReports = '';
    let latestFindingRowId = null;
    let prescriptionHistory = [];

    if (ticketIds.length > 0) {
      const { data: findingsData } = await supabase
        .from('channeling_findings_master')
        .select('id, ticket_id, findings_comment, insert_date')
        .in('ticket_id', ticketIds)
        .order('id', { ascending: false });

      if (findingsData && findingsData.length > 0) {
        const latestWithComment = findingsData.find(f => f.findings_comment && f.findings_comment.trim() !== '') || findingsData[0];
        allergiesAndReports = latestWithComment.findings_comment || '';
        latestFindingRowId = latestWithComment.id;
      }

      const { data: channelingData } = await supabase
        .from('channeling_master')
        .select('id, ticket_id, general, reason_remarks, insert_date')
        .in('ticket_id', ticketIds)
        .order('id', { ascending: false });

      prescriptionHistory = (channelingData || [])
        .filter(c => c.general && c.general.trim() !== '')
        .map(c => ({
          id: c.id,
          ticket_id: c.ticket_id,
          general: c.general,
          reason_remarks: c.reason_remarks || '',
          visit_date: c.insert_date || ticketDateMap[c.ticket_id] || null
        }));
    }

    res.json({
      patient,
      allergiesAndReports,
      latestFindingRowId,
      prescriptionHistory
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// ROUTE 6: Update "Common Details" in patients_master
// ============================================================================
app.put('/api/patients/:id/common', async (req, res) => {
  try {
    const patientId = Number(req.params.id);
    const { common } = req.body;

    const { data, error } = await supabase
      .from('patients_master')
      .update({ common: common || '' })
      .eq('id', patientId)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, common: data.common });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// ROUTE 7: Update "Allergies & Reports" in channeling_findings_master
// ============================================================================
app.put('/api/patients/:id/allergies-reports', async (req, res) => {
  try {
    const patientId = Number(req.params.id);
    const { findings_comment, active_ticket_id, doctor_id } = req.body;

    let ticketId = active_ticket_id;

    if (!ticketId) {
      const { data: existingTickets } = await supabase
        .from('ticket_master')
        .select('id')
        .eq('patient_id', patientId)
        .order('id', { ascending: false })
        .limit(1);

      if (existingTickets && existingTickets.length > 0) {
        ticketId = existingTickets[0].id;
      } else {
        ticketId = await getNextId('ticket_master');
        const today = new Date().toISOString().split('T')[0];
        await supabase.from('ticket_master').insert([{
          id: ticketId,
          number: 1,
          booking_method: 'Direct Walk-In',
          timeframe_id: 1,
          patient_id: patientId,
          channeling_date: today,
          channeling_doctor_id: doctor_id || 1,
          institutional_fee: 0,
          billing_amount: 0,
          insert_by_id: doctor_id || 1,
          insert_date: new Date().toISOString(),
          flag: 1
        }]);
      }
    }

    const { data: existingFinding } = await supabase
      .from('channeling_findings_master')
      .select('id')
      .eq('ticket_id', ticketId)
      .order('id', { ascending: false })
      .limit(1);

    if (existingFinding && existingFinding.length > 0) {
      const { error: updErr } = await supabase
        .from('channeling_findings_master')
        .update({ findings_comment: findings_comment || '' })
        .eq('id', existingFinding[0].id);

      if (updErr) throw updErr;
    } else {
      const nextFindingRowId = await getNextId('channeling_findings_master');
      const { error: insErr } = await supabase
        .from('channeling_findings_master')
        .insert([{
          id: nextFindingRowId,
          ticket_id: ticketId,
          finding_id: 1,
          findings_comment: findings_comment || '',
          insert_by_id: doctor_id || 1,
          insert_date: new Date().toISOString(),
          flag: 1
        }]);

      if (insErr) throw insErr;
    }

    res.json({ success: true, ticket_id: ticketId, findings_comment });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ============================================================================
// ROUTE 8: Submit Prescription ("To Counter")
// ============================================================================
app.post('/api/doctor/prescribe', async (req, res) => {
  try {
    const { patient_id, ticket_id, general, reason_remarks, doctor_id, doctor_name, patient_name } = req.body;

    if (!patient_id || !general || !general.trim()) {
      return res.status(400).json({ error: 'Patient and prescription text are required.' });
    }

    // 1. Build true Sri Lanka Date (YYYY-MM-DD) and Timestamp (+05:30) without .toISOString() UTC conversion
    const now = new Date();
    const slDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Colombo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(now);

    const slTimeStr = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Colombo',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(now);

    // Exact Sri Lanka timestamp for database storage (never rolls back to yesterday)
    const slTimestamp = `${slDateStr}T${slTimeStr}+05:30`;

    let finalTicketId = ticket_id ? Number(ticket_id) : null;

    // 2. If prescribing from "Find Patient", ticket_id is null -> Generate next safe ID manually
    if (!finalTicketId) {
      const { data: maxTicketRow } = await supabase
        .from('ticket_master')
        .select('id')
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();

      finalTicketId = (maxTicketRow?.id ? Number(maxTicketRow.id) : 0) + 1;

      const { error: createTickErr } = await supabase
        .from('ticket_master')
        .insert([{
          id: finalTicketId,
          number: finalTicketId,
          booking_method: 'Direct Consult',
          timeframe_id: 1,
          patient_id: Number(patient_id),
          channeling_date: slDateStr,
          channeling_doctor_id: doctor_id || 1,
          institutional_fee: 0,
          billing_amount: 0,
          insert_by_id: doctor_id || 1,
          insert_date: slTimestamp,
          flag: 2
        }]);

      if (createTickErr) throw createTickErr;
    } else {
      // If prescribing from Queue, update existing ticket to flag = 2 (Sent to Counter)
      const { error: updTickErr } = await supabase
        .from('ticket_master')
        .update({ flag: 2, channeling_doctor_id: doctor_id || 1 })
        .eq('id', finalTicketId);

      if (updTickErr) throw updTickErr;
    }

    // 3. Insert or Update channeling_master with explicit ID generation
    const { data: existingChanneling } = await supabase
      .from('channeling_master')
      .select('id')
      .eq('ticket_id', finalTicketId)
      .limit(1);

    let channelingRow;

    if (existingChanneling && existingChanneling.length > 0) {
      const { data, error } = await supabase
        .from('channeling_master')
        .update({
          general: general.trim(),
          reason_remarks: reason_remarks || '',
          insert_date: slTimestamp,
          flag: 1
        })
        .eq('id', existingChanneling[0].id)
        .select()
        .single();

      if (error) throw error;
      channelingRow = data;
    } else {
      const { data: maxChanRow } = await supabase
        .from('channeling_master')
        .select('id')
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();

      const nextChannelingId = (maxChanRow?.id ? Number(maxChanRow.id) : 0) + 1;

      const { data, error } = await supabase
        .from('channeling_master')
        .insert([{
          id: nextChannelingId,
          ticket_id: finalTicketId,
          reason_remarks: reason_remarks || '',
          general: general.trim(),
          insert_by_id: doctor_id || 1,
          insert_date: slTimestamp,
          flag: 1
        }])
        .select()
        .single();

      if (error) throw error;
      channelingRow = data;
    }

    // 4. Update patient's last visit date in Sri Lanka time
    await supabase
      .from('patients_master')
      .update({ last_visit_date: slTimestamp })
      .eq('id', Number(patient_id));

    // 5. Notify Counter
    await supabase.from('counter_alerts').insert([{
      alert_type: 'NEW_PRESCRIPTION',
      doctor_id: doctor_id || 1,
      doctor_name: doctor_name || 'Doctor',
      ticket_id: finalTicketId,
      patient_name: patient_name || 'Patient',
      message: general.trim()
    }]);

    res.json({ success: true, ticket_id: finalTicketId, channeling: channelingRow });
  } catch (err) {
    console.error('Prescribe Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ============================================================================
// ROUTE 9: Ring Counter Bell
// ============================================================================
app.post('/api/doctor/bell', async (req, res) => {
  try {
    const { doctor_id, doctor_name } = req.body;
    const { data, error } = await supabase
      .from('counter_alerts')
      .insert([{
        alert_type: 'BELL_RING',
        doctor_id: doctor_id || 1,
        doctor_name: doctor_name || 'Doctor',
        message: 'Doctor rang the counter bell!'
      }])
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, alert: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ============================================================================
// ROUTE: Update Marital Status in patients_master
// ============================================================================
app.put('/api/patients/:id/marital-status', async (req, res) => {
  try {
    const patientId = Number(req.params.id);
    const { married } = req.body;

    const { data, error } = await supabase
      .from('patients_master')
      .update({ married: Number(married) })
      .eq('id', patientId)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, married: data.married });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ============================================================================
// COUNTER ROUTE 1: Encrypted Counter Staff Login
// ============================================================================
app.post('/api/counter/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const { data: staff, error } = await supabase
      .from('counter_staff_master')
      .select('id, name, role, username, password, flag')
      .eq('username', username.trim())
      .eq('flag', 1)
      .single();

    if (error || !staff) {
      return res.status(401).json({ error: 'Invalid counter username or password.' });
    }

    const isMatch = await bcrypt.compare(password, staff.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid counter username or password.' });
    }

    await supabase
      .from('counter_staff_master')
      .update({ is_online: true })
      .eq('id', staff.id);

    res.json({
      id: staff.id,
      name: staff.name,
      role: staff.role,
      username: staff.username
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// COUNTER ROUTE 2: Fetch Active Doctor Prescriptions Sent to Counter (flag = 2)
// ============================================================================
app.get('/api/counter/prescriptions', async (req, res) => {
  try {
    const { data: tickets, error: tickErr } = await supabase
      .from('ticket_master')
      .select('*')
      .eq('flag', 2)
      .order('id', { ascending: true })
      .limit(50);

    if (tickErr) throw tickErr;
    if (!tickets || tickets.length === 0) return res.json([]);

    const patientIds = [...new Set(tickets.map(t => t.patient_id).filter(Boolean))];
    const ticketIds = tickets.map(t => t.id);

    const [{ data: patients }, { data: channelings }, { data: doctors }] = await Promise.all([
      supabase.from('patients_master').select('id, name, phone, birth_date, gender').in('id', patientIds),
      supabase.from('channeling_master').select('ticket_id, general, reason_remarks, insert_date').in('ticket_id', ticketIds).order('id', { ascending: false }),
      supabase.from('doctors_master').select('id, name')
    ]);

    const patMap = {};
    (patients || []).forEach(p => { patMap[p.id] = p; });

    const rxMap = {};
    (channelings || []).forEach(c => {
      if (!rxMap[c.ticket_id]) rxMap[c.ticket_id] = c;
    });

    const docMap = {};
    (doctors || []).forEach(d => { docMap[d.id] = d.name; });

    const list = tickets
      .map(t => ({
        ticket_id: t.id,
        ticket_number: t.number || t.id,
        doctor_name: docMap[t.channeling_doctor_id] || 'Consulting Physician',
        patient: patMap[t.patient_id] || null,
        prescription: rxMap[t.id]?.general || 'Consultation Completed (No shorthand text)',
        sent_at: rxMap[t.id]?.insert_date || t.insert_date
      }))
      .filter(item => item.patient !== null);

    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// COUNTER ROUTE 3: Load Medicines & Dispensary Services Catalog
// ============================================================================
app.get('/api/counter/catalog', async (req, res) => {
  try {
    const [{ data: medicines, error: medErr }, { data: services, error: srvErr }] = await Promise.all([
      supabase.from('medicines_master').select('*').eq('flag', 1).order('name', { ascending: true }),
      supabase.from('clinic_services_master').select('*').eq('flag', 1).order('id', { ascending: true })
    ]);

    if (medErr) throw medErr;
    if (srvErr) throw srvErr;

    res.json({
      medicines: medicines || [],
      services: services || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// COUNTER ROUTE 4: Save or Auto-Update Medicine Price in Database
// ============================================================================
app.post('/api/counter/medicines/upsert', async (req, res) => {
  try {
    const { id, name, unit_price } = req.body;
    const cleanName = (name || '').trim();
    const cleanPrice = Number(unit_price) || 0;

    if (!cleanName) {
      return res.status(400).json({ error: 'Medicine name is required' });
    }

    if (id) {
      const { data, error } = await supabase
        .from('medicines_master')
        .update({ unit_price: cleanPrice, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return res.json(data);
    } else {
      const { data, error } = await supabase
        .from('medicines_master')
        .upsert([{ name: cleanName, unit_price: cleanPrice, updated_at: new Date().toISOString(), flag: 1 }], { onConflict: 'name' })
        .select()
        .single();
      if (error) throw error;
      return res.json(data);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// COUNTER ROUTE 5: Check & Clear Doctor Bell Alerts
// ============================================================================
app.get('/api/counter/alerts', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('counter_alerts')
      .select('*')
      .eq('alert_type', 'BELL_RING')
      .order('id', { ascending: false })
      .limit(1);

    if (error) throw error;
    res.json(data && data.length > 0 ? data[0] : null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Helper: Always get current YYYY-MM-DD in Sri Lanka Time (UTC+5:30), even on cloud servers
function getSriLankaTodayRange() {
  const slDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Colombo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());

  return {
    dateStr: slDateStr,
    startISO: `${slDateStr}T00:00:00.000+05:30`,
    endISO: `${slDateStr}T23:59:59.999+05:30`
  };
}

// ============================================================================
// COUNTER ROUTE 6: Complete POS Checkout OR Outdoor Medicine Removal
// ============================================================================
app.post('/api/counter/checkout', async (req, res) => {
  try {
    const {
      ticket_ids,
      patient_names,
      patient_phone,
      doctor_name,
      bill_status,
      calculated_total,
      final_total,
      items_snapshot,
      created_by
    } = req.body;

    if (Array.isArray(ticket_ids) && ticket_ids.length > 0) {
      const { error: tickErr } = await supabase
        .from('ticket_master')
        .update({ flag: 3, billing_amount: Number(final_total) || 0 })
        .in('id', ticket_ids);
      if (tickErr) throw tickErr;
    }

    const { startISO, endISO } = getSriLankaTodayRange();
    const { count: todayCount } = await supabase
      .from('pharmacy_bills')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', startISO)
      .lte('created_at', endISO);

    const dailyBillNumber = (todayCount || 0) + 1;

    // FIX: Calculate RAW MEDICINE COST for the Admin Profit calculation
    const totalMedicineCost = (items_snapshot || [])
      .filter(item => item.item_type === 'MEDICINE')
      .reduce((sum, item) => sum + (Number(item.line_total) || 0), 0);

    const { data: bill, error: billErr } = await supabase
      .from('pharmacy_bills')
      .insert([{
        ticket_ids: ticket_ids || [],
        patient_names: patient_names || 'Walk-In Patient',
        patient_phone: patient_phone || '',
        doctor_name: doctor_name || 'Consulting Physician',
        bill_status: bill_status || 'COMPLETED_BILL',
        calculated_total: Number(calculated_total) || 0,
        final_total: Number(final_total) || 0,
        total_medicine_cost: totalMedicineCost, // Saved safely in the background!
        items_snapshot: items_snapshot || [],
        created_by: created_by || 'Counter'
      }])
      .select()
      .single();

    if (billErr) throw billErr;

    res.json({ success: true, bill: { ...bill, daily_bill_no: dailyBillNumber } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ============================================================================
// COUNTER ROUTE 7: Get Today's Log with Daily Bill Numbers (#1, #2, #3...)
// ============================================================================
app.get('/api/counter/today-log', async (req, res) => {
  try {
    const { startISO, endISO } = getSriLankaTodayRange();

    // Fetch oldest-first to assign #1, #2, #3 accurately for today
    const { data, error } = await supabase
      .from('pharmacy_bills')
      .select('*')
      .gte('created_at', startISO)
      .lte('created_at', endISO)
      .order('id', { ascending: true });

    if (error) throw error;

    // Assign daily_bill_no starting at 1, then reverse so newest is at top of table
    const numberedList = (data || [])
      .map((row, index) => ({
        ...row,
        daily_bill_no: index + 1
      }))
      .reverse();

    res.json(numberedList);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ============================================================================
// ROUTE 8: Submit Prescription ("To Counter")
// ============================================================================
app.post('/api/doctor/prescribe', async (req, res) => {
  try {
    const { patient_id, ticket_id, general, reason_remarks, doctor_id, doctor_name, patient_name } = req.body;

    if (!patient_id || !general || !general.trim()) {
      return res.status(400).json({ error: 'Patient and prescription text are required.' });
    }

    const now = new Date().toISOString();
    // FIX: Force Sri Lanka Time for accurate date logging
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo' }).format(new Date());
    
    let finalTicketId = ticket_id;

    if (!finalTicketId) {
      finalTicketId = await getNextId('ticket_master');
      const { error: createTickErr } = await supabase.from('ticket_master').insert([{
        id: finalTicketId,
        number: finalTicketId,
        booking_method: 'Direct Consult',
        timeframe_id: 1,
        patient_id: Number(patient_id),
        channeling_date: today,
        channeling_doctor_id: doctor_id || 1,
        institutional_fee: 0,
        billing_amount: 0,
        insert_by_id: doctor_id || 1,
        insert_date: now,
        flag: 2 
      }]);
      if (createTickErr) throw createTickErr;
    } else {
      await supabase
        .from('ticket_master')
        .update({ flag: 2, channeling_doctor_id: doctor_id || 1 })
        .eq('id', finalTicketId);
    }

    const { data: existingChanneling } = await supabase
      .from('channeling_master')
      .select('id')
      .eq('ticket_id', finalTicketId)
      .limit(1);

    let channelingRow;

    if (existingChanneling && existingChanneling.length > 0) {
      const { data, error } = await supabase
        .from('channeling_master')
        .update({
          general: general.trim(),
          reason_remarks: reason_remarks || '',
          insert_date: now,
          flag: 1
        })
        .eq('id', existingChanneling[0].id)
        .select()
        .single();
      if (error) throw error;
      channelingRow = data;
    } else {
      const nextChannelingId = await getNextId('channeling_master');
      const { data, error } = await supabase
        .from('channeling_master')
        .insert([{
          id: nextChannelingId,
          ticket_id: finalTicketId,
          reason_remarks: reason_remarks || '',
          general: general.trim(),
          insert_by_id: doctor_id || 1,
          insert_date: now,
          flag: 1
        }])
        .select()
        .single();
      if (error) throw error;
      channelingRow = data;
    }

    await supabase
      .from('patients_master')
      .update({ last_visit_date: now })
      .eq('id', Number(patient_id));

    await supabase.from('counter_alerts').insert([{
      alert_type: 'NEW_PRESCRIPTION',
      doctor_id: doctor_id || 1,
      doctor_name: doctor_name || 'Doctor',
      ticket_id: finalTicketId,
      patient_name: patient_name || 'Patient',
      message: general.trim()
    }]);

    res.json({ success: true, ticket_id: finalTicketId, channeling: channelingRow });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// COUNTER ROUTE 9: Add Patient to Today's Active Doctor Queue (flag = 1)
// ============================================================================
app.post('/api/counter/queue/add', async (req, res) => {
  try {
    const { patient_id, doctor_id } = req.body;
    if (!patient_id) {
      return res.status(400).json({ error: 'Patient ID is required.' });
    }

    const { dateStr: todaySL } = getSriLankaTodayRange();

    // Prevent accidental duplicate queue entries for the same patient today
    const { data: existingWaiting } = await supabase
      .from('ticket_master')
      .select('id, number')
      .eq('patient_id', Number(patient_id))
      .eq('channeling_date', todaySL)
      .eq('flag', 1)
      .limit(1);

    if (existingWaiting && existingWaiting.length > 0) {
      return res.status(400).json({ error: 'This patient is already in today\'s active waiting queue.' });
    }

    // Calculate today's daily ticket number starting from 1
    const { count: todayTicketsCount } = await supabase
      .from('ticket_master')
      .select('id', { count: 'exact', head: true })
      .eq('channeling_date', todaySL);

    const nextDailyNumber = (todayTicketsCount || 0) + 1;
    const nextTicketId = await getNextId('ticket_master');

    const { data: newTicket, error: insErr } = await supabase
      .from('ticket_master')
      .insert([{
        id: nextTicketId,
        number: nextDailyNumber,
        booking_method: 'Counter Queue',
        timeframe_id: 1,
        patient_id: Number(patient_id),
        channeling_date: todaySL,
        channeling_doctor_id: doctor_id || 1,
        institutional_fee: 0,
        billing_amount: 0,
        insert_by_id: 1,
        insert_date: new Date().toISOString(),
        flag: 1
      }])
      .select()
      .single();

    if (insErr) throw insErr;
    res.json({ success: true, ticket: newTicket, daily_number: nextDailyNumber });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// COUNTER ROUTE 10: Remove / Cancel Patient from Active Queue (Walk-Out -> flag = 0)
// ============================================================================
app.put('/api/counter/queue/:ticketId/cancel', async (req, res) => {
  try {
    const ticketId = Number(req.params.ticketId);
    const { error } = await supabase
      .from('ticket_master')
      .update({ flag: 0 })
      .eq('id', ticketId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// ROUTE 11: Update Gender in patients_master
// ============================================================================
app.put('/api/patients/:id/gender', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('patients_master')
      .update({ gender: Number(req.body.gender) })
      .eq('id', Number(req.params.id))
      .select().single();
    if (error) throw error;
    res.json({ success: true, gender: data.gender });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// ADMIN ROUTE 1: Encrypted Admin Login
// ============================================================================
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

    const { data: admin, error } = await supabase
      .from('admin_master')
      .select('id, name, username, password')
      .eq('username', username.trim())
      .eq('flag', 1)
      .single();

    if (error || !admin) return res.status(401).json({ error: 'Invalid admin credentials.' });

    const bcrypt = require('bcryptjs'); // FIX: Using bcryptjs
    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid admin credentials.' });

    res.json({ id: admin.id, name: admin.name, username: admin.username, role: 'Administrator' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// ADMIN ROUTE 2: Financial Dashboard Analytics (Powered by Postgres RPC)
// ============================================================================
app.get('/api/admin/finance', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    // Default to a vast range if ALL time is selected (covers 2010 to 2050)
    const startIso = startDate ? `${startDate}T00:00:00.000+05:30` : '2010-01-01T00:00:00.000+05:30';
    const endIso = endDate ? `${endDate}T23:59:59.999+05:30` : '2050-12-31T23:59:59.999+05:30';

    // Execute all 3 heavy data crunching functions concurrently inside the database
    const [
      { data: finData, error: finErr },
      { data: topMeds, error: medErr },
      { data: traffic, error: trafErr }
    ] = await Promise.all([
      supabase.rpc('get_financial_metrics', { start_d: startIso, end_d: endIso }),
      supabase.rpc('get_top_medicines', { start_d: startIso, end_d: endIso }),
      supabase.rpc('get_weekly_traffic', { start_d: startIso, end_d: endIso })
    ]);

    if (finErr) throw finErr;
    if (medErr) throw medErr;
    if (trafErr) throw trafErr;

    res.json({
      summary: finData.summary,
      chartData: finData.daily,
      topMedicines: topMeds,
      weeklyTraffic: traffic
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// ADMIN ROUTE 3: Patient Demographics & Age Bell Curve (Powered by Postgres RPC)
// ============================================================================
app.get('/api/admin/demographics', async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('get_patient_demographics');
    
    // NEW: If Supabase crashes, print the exact reason to the Node.js terminal
    if (error) {
      console.error("SUPABASE RPC CRASH ERROR:", error);
      throw error;
    }

    const bellCurveData = Object.keys(data.age).map(range => ({
      ageGroup: range,
      patients: data.age[range]
    }));

    const genderData = [
      { name: 'Male', value: data.gender.male, fill: '#38bdf8' },
      { name: 'Female', value: data.gender.female, fill: '#f472b6' },
      { name: 'Not Specified', value: data.gender.unspecified, fill: '#64748b' }
    ];

    res.json({
      bellCurveData,
      genderData,
      totalRegistered: data.total
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ============================================================================
// ADMIN ROUTE 4: Daily Business Spreadsheet Log (With Timezone Safety)
// ============================================================================
app.get('/api/admin/daily-log', async (req, res) => {
  try {
    const { date } = req.query; // Expects YYYY-MM-DD
    if (!date) return res.status(400).json({ error: 'Date is required' });

    const startIso = `${date}T00:00:00.000+05:30`;
    const endIso = `${date}T23:59:59.999+05:30`;

    const { data, error } = await supabase
      .from('pharmacy_bills')
      .select('*')
      .gte('created_at', startIso)
      .lte('created_at', endIso)
      .order('id', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// ADMIN ROUTE 5: Get All Registered Users (Doctors & Cashiers)
// ============================================================================
app.get('/api/admin/users', async (req, res) => {
  try {
    const [docs, cashiers] = await Promise.all([
      supabase.from('doctors_master').select('id, name, username, specialty').eq('flag', 1),
      supabase.from('counter_staff_master').select('id, name, username, role').eq('flag', 1)
    ]);
    res.json({
      doctors: docs.data || [],
      cashiers: cashiers.data || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// ADMIN ROUTE 6: Register New Doctor or Cashier
// ============================================================================
app.post('/api/admin/users', async (req, res) => {
  try {
    const { role_type, name, username, password, specialty_or_role } = req.body;
    if (!name || !username || !password) return res.status(400).json({ error: 'Missing fields' });

    const bcrypt = require('bcryptjs'); // FIX: Using bcryptjs
    const hashedPassword = await bcrypt.hash(password, 10);
    const table = role_type === 'DOCTOR' ? 'doctors_master' : 'counter_staff_master';
    
    const payload = {
      name, username, password: hashedPassword,
      ...(role_type === 'DOCTOR' ? { specialty: specialty_or_role } : { role: specialty_or_role })
    };

    const { data, error } = await supabase.from(table).insert([payload]).select().single();
    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'Username already exists.' });
      throw error;
    }
    res.json({ success: true, user: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// ADMIN ROUTE 7: Delete User (Soft Delete)
// ============================================================================
app.delete('/api/admin/users/:type/:id', async (req, res) => {
  try {
    const table = req.params.type === 'DOCTOR' ? 'doctors_master' : 'counter_staff_master';
    const { error } = await supabase.from(table).update({ flag: 0 }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GRN ROUTE 1: Universal Login (Accepts Admin, Doctor, OR Counter)
// ============================================================================
app.post('/api/grn/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Credentials required.' });

    const bcrypt = require('bcryptjs'); // FIX: Using bcryptjs
    
    // Check all 3 tables concurrently
    const [adminRes, docRes, counterRes] = await Promise.all([
      supabase.from('admin_master').select('*').eq('username', username.trim()).eq('flag', 1).maybeSingle(),
      supabase.from('doctors_master').select('*').eq('username', username.trim()).eq('flag', 1).maybeSingle(),
      supabase.from('counter_staff_master').select('*').eq('username', username.trim()).eq('flag', 1).maybeSingle()
    ]);

    let user = adminRes.data || docRes.data || counterRes.data;
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials.' });

    res.json({ id: user.id, name: user.name, username: user.username, access: 'GRANTED' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GRN ROUTE 2: Delete/Remove Medicine from Catalog
// ============================================================================
app.delete('/api/grn/medicines/:id', async (req, res) => {
  try {
    // We can safely hard-delete from the catalog because pharmacy_bills uses a JSON snapshot (items_snapshot) 
    // that permanently preserves the name and price of the item at the time it was sold.
    const { error } = await supabase.from('medicines_master').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Wellspring Backend API running on http://localhost:${PORT}`);
});