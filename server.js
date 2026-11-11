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
// ROUTE 2: Get Active Waiting Queue for Today
// ============================================================================
app.get('/api/doctor/queue', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const { data: tickets, error: ticketErr } = await supabase
      .from('ticket_master')
      .select('*')
      .eq('flag', 1)
      .order('id', { ascending: true })
      .limit(50);

    if (ticketErr) throw ticketErr;
    if (!tickets || tickets.length === 0) return res.json([]);

    const patientIds = [...new Set(tickets.map(t => t.patient_id).filter(Boolean))];
    const { data: patients, error: patErr } = await supabase
      .from('patients_master')
      .select('id, name, phone, birth_date, gender, common, reference, id_number, weight, height')
      .in('id', patientIds);

    if (patErr) throw patErr;

    const patientMap = {};
    (patients || []).forEach(p => { patientMap[p.id] = p; });

    const queue = tickets
      .map(t => ({
        ticket_id: t.id,
        ticket_number: t.number || t.id,
        channeling_date: t.channeling_date || today,
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

    if (!name && !nic && !phone && !dob) {
      return res.json({ data: [], page, hasMore: false });
    }

    let queryBuilder = supabase
      .from('patients_master')
      .select('id, name, reference, common, id_number, phone, birth_date, gender, weight, height, last_visit_date');

    if (name) queryBuilder = queryBuilder.ilike('name', `%${name.trim()}%`);
    if (nic) queryBuilder = queryBuilder.ilike('id_number', `%${nic.trim()}%`);
    
    // FIX: Ignore the leading '0' for phone numbers so it matches 077... and 77...
    if (phone) {
      let cleanPhone = phone.trim();
      if (cleanPhone.startsWith('0')) {
        cleanPhone = cleanPhone.substring(1);
      }
      queryBuilder = queryBuilder.ilike('phone', `%${cleanPhone}%`);
    }
    
    if (dob) queryBuilder = queryBuilder.eq('birth_date', dob);

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

    const now = new Date().toISOString();
    const today = now.split('T')[0];
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

    res.json({
      success: true,
      ticket_id: finalTicketId,
      channeling: channelingRow
    });
  } catch (err) {
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

app.listen(PORT, () => {
  console.log(`Wellspring Backend API running on http://localhost:${PORT}`);
});