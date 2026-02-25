#!/usr/bin/env node

/**
 * RLDX Waitlist → Notion Sync Script
 *
 * Fetches waitlist submissions from Supabase and creates
 * Notion database rows with all form data as properties.
 *
 * All labels, section groupings, and question texts are
 * auto-extracted from index.html — zero hardcoded mappings.
 *
 * Usage: node sync-notion.js [--dry-run]
 *
 * Zero dependencies — uses Node.js built-in fetch (v18+).
 */

// ============================================
// Configuration — loaded from sync-config.json
// ============================================
const path = require('path');
const fs = require('fs');

const configPath = path.join(__dirname, 'sync-config.json');
if (!fs.existsSync(configPath)) {
  console.error('Missing sync-config.json. Copy sync-config.example.json and fill in your keys.');
  process.exit(1);
}
const CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const DRY_RUN = process.argv.includes('--dry-run');

// ============================================
// Constants
// ============================================
const NOTION_PAGE_SIZE = 100;
const NOTION_RATE_LIMIT_DELAY = 350;
const PREVIEW_WIDTH = 72;

// Profile fields stored as individual Notion columns (not merged into sections)
const PROFILE_KEYS = ['fullName', 'email', 'organization', 'country', 'socialProfile'];

// ============================================
// Auto-extract from index.html
// ============================================

function parseHtml() {
  const htmlPath = path.join(__dirname, '..', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  return html;
}

/**
 * Extract LABELS: { fieldName: { value: "option-label text" } }
 */
function extractLabels(html) {
  const labels = {};

  // radio/checkbox: name before value
  const r1 = /<input\s+type="(?:radio|checkbox)"\s+[^>]*name="([^"]+)"\s+[^>]*value="([^"]+)"[^>]*>\s*<span\s+class="option-label">([^<]+)<\/span>/g;
  let m;
  while ((m = r1.exec(html)) !== null) {
    const [, name, value, text] = m;
    if (!labels[name]) labels[name] = {};
    labels[name][value] = text.trim();
  }

  // radio/checkbox: value before name (attribute order varies)
  const r2 = /<input\s+type="(?:radio|checkbox)"\s+[^>]*value="([^"]+)"\s+[^>]*name="([^"]+)"[^>]*>\s*<span\s+class="option-label">([^<]+)<\/span>/g;
  while ((m = r2.exec(html)) !== null) {
    const [, value, name, text] = m;
    if (!labels[name]) labels[name] = {};
    if (!labels[name][value]) labels[name][value] = text.trim();
  }

  // <select> options
  const selectRe = /<select[^>]+name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g;
  while ((m = selectRe.exec(html)) !== null) {
    const [, name, optionsHtml] = m;
    if (!labels[name]) labels[name] = {};
    const optRe = /<option\s+value="([^"]*)"[^>]*>([^<]+)<\/option>/g;
    let om;
    while ((om = optRe.exec(optionsHtml)) !== null) {
      const [, value, text] = om;
      if (value) labels[name][value] = text.trim();
    }
  }

  return labels;
}

/**
 * Extract section structure: [{ title, fields: [{ key, question }] }]
 * Reads form-section blocks, section-title, form-label, and input names.
 */
function extractSections(html) {
  const sectionRegex = /<div\s+class="form-section">([\s\S]*?)(?=<div\s+class="form-section">|<!-- Honeypot|<div\s+class="submit-section")/g;
  let m;
  const sections = [];

  while ((m = sectionRegex.exec(html)) !== null) {
    const block = m[1];

    // Section title
    const titleMatch = block.match(/<h3\s+class="section-title">([^<]+)<\/h3>/);
    const title = titleMatch ? titleMatch[1].trim() : 'Other';

    // Find each form-label and the input names that follow it
    const fields = [];
    const labelRegex = /<label[^>]*class="form-label"[^>]*>([\s\S]*?)<\/label>/g;
    let lm;
    const labelPositions = [];

    while ((lm = labelRegex.exec(block)) !== null) {
      let text = lm[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      text = text.replace(/\s*\*\s*/g, ' ').trim();
      text = text.replace(/\s*\([^)]*\)\s*$/, '').trim();
      labelPositions.push({ text, endPos: lm.index + lm[0].length });
    }

    for (let i = 0; i < labelPositions.length; i++) {
      const startPos = labelPositions[i].endPos;
      const endPos = i + 1 < labelPositions.length ? labelPositions[i + 1].endPos : block.length;
      const region = block.substring(startPos, endPos);

      const names = [];
      const seen = new Set();
      const nameRegex = /name="([^"]+)"/g;
      let nm;
      while ((nm = nameRegex.exec(region)) !== null) {
        if (nm[1] !== 'website' && !seen.has(nm[1])) {
          seen.add(nm[1]);
          names.push(nm[1]);
        }
      }

      for (const name of names) {
        fields.push({ key: name, question: labelPositions[i].text });
      }
    }

    sections.push({ title, fields });
  }

  return sections;
}

const HTML = parseHtml();
const LABELS = extractLabels(HTML);
const SECTIONS = extractSections(HTML);

// ============================================
// Helpers
// ============================================

/** Normalize value to array */
function toArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

/** Look up display text for a code value, fall back to raw code */
function resolveLabel(fieldKey, code) {
  if (!code) return '';
  const map = LABELS[fieldKey];
  if (map && map[code]) return map[code];
  return code;
}

/** Resolve a single or array value to display text(s) */
function resolveValue(fieldKey, val) {
  if (!val || val === '') return '';
  if (Array.isArray(val)) {
    return val.map(v => resolveLabel(fieldKey, v)).filter(Boolean).join(', ');
  }
  return resolveLabel(fieldKey, val);
}

/** Build merged text for a section from form_data */
function buildSectionText(section, fd) {
  const lines = [];
  const processedKeys = new Set();

  for (const field of section.fields) {
    const { key, question } = field;
    if (processedKeys.has(key)) continue;
    if (PROFILE_KEYS.includes(key)) continue;

    const isOtherField = key.endsWith('Other');
    if (isOtherField) continue; // handled inline with the parent field

    const val = fd[key];
    if (val === undefined || val === null) continue;

    processedKeys.add(key);

    let displayVal = resolveValue(key, val);
    if (!displayVal && val === '') continue;

    // Append "Other" text input if present
    const otherKey = key + 'Other';
    const otherVal = fd[otherKey];
    if (otherVal && otherVal !== '') {
      // If the selected value was "other", show "Other: <text>"
      const rawVal = Array.isArray(val) ? val : [val];
      if (rawVal.includes('other')) {
        // Replace "Other" in the display with "Other: <text>"
        const otherLabel = resolveLabel(key, 'other');
        displayVal = displayVal.replace(otherLabel, `${otherLabel}: ${otherVal}`);
      } else {
        displayVal += `, ${otherVal}`;
      }
    }

    if (displayVal) {
      lines.push(`${question}: ${displayVal}`);
    }
  }

  return lines.join('\n');
}

/** Create a Notion rich_text array from a string */
function richText(content) {
  return [{ type: 'text', text: { content: content || '' } }];
}

// ============================================
// Supabase — Fetch all waitlist rows
// ============================================

async function fetchSupabaseRows() {
  const res = await fetch(
    `${CONFIG.supabase.url}/rest/v1/waitlist?select=*&order=created_at.asc`,
    {
      headers: {
        'apikey': CONFIG.supabase.serviceRoleKey,
        'Authorization': `Bearer ${CONFIG.supabase.serviceRoleKey}`,
      },
    }
  );
  if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ============================================
// Notion — Ensure section columns exist
// ============================================

async function ensureSectionColumns() {
  // Fetch current database schema
  const res = await fetch(
    `https://api.notion.com/v1/databases/${CONFIG.notion.databaseId}`,
    {
      headers: {
        'Authorization': `Bearer ${CONFIG.notion.token}`,
        'Notion-Version': '2022-06-28',
      },
    }
  );
  if (!res.ok) throw new Error(`Notion DB fetch failed: ${res.status} ${await res.text()}`);
  const db = await res.json();
  const existingProps = Object.keys(db.properties);

  // Find missing section columns
  const neededColumns = SECTIONS
    .filter(s => s.title !== 'Contact Information')
    .map(s => s.title);

  const missing = neededColumns.filter(col => !existingProps.includes(col));
  if (missing.length === 0) return;

  console.log(`  Adding Notion columns: ${missing.join(', ')}`);

  // Add missing columns as rich_text properties
  const properties = {};
  for (const col of missing) {
    properties[col] = { rich_text: {} };
  }

  const updateRes = await fetch(
    `https://api.notion.com/v1/databases/${CONFIG.notion.databaseId}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${CONFIG.notion.token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({ properties }),
    }
  );
  if (!updateRes.ok) throw new Error(`Notion DB update failed: ${updateRes.status} ${await updateRes.text()}`);
  console.log('  Columns added successfully.\n');
}

// ============================================
// Notion — Query existing emails in database
// ============================================

async function getExistingEmails() {
  const emails = new Set();
  let cursor = undefined;

  while (true) {
    const body = { page_size: NOTION_PAGE_SIZE };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(
      `https://api.notion.com/v1/databases/${CONFIG.notion.databaseId}/query`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.notion.token}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28',
        },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) throw new Error(`Notion query failed: ${res.status} ${await res.text()}`);

    const data = await res.json();
    for (const page of data.results) {
      const email = page.properties?.Email?.email;
      if (email) emails.add(email.toLowerCase());
    }

    if (!data.has_more) break;
    cursor = data.next_cursor;
  }

  return emails;
}

// ============================================
// Transform — Supabase row → Notion properties
// ============================================

function buildProperties(row) {
  const fd = row.form_data || {};

  const props = {
    'Name': { title: richText(row.full_name || fd.fullName || '') },
    'Email': { email: row.email || fd.email || null },
    'Organization': { rich_text: richText(row.organization || fd.organization || '') },
    'Country': { select: { name: resolveLabel('country', row.country || fd.country) || 'Other' } },
  };

  // Social Profile — only include if valid URL
  const social = row.social_profile || fd.socialProfile || '';
  if (social && social.startsWith('http')) {
    props['Social Profile'] = { url: social };
  }

  // Submitted date
  if (row.created_at) {
    props['Submitted'] = { date: { start: row.created_at.split('T')[0] } };
  }

  // Section columns — skip "Contact Information" (already covered by profile fields)
  for (const section of SECTIONS) {
    if (section.title === 'Contact Information') continue;

    const text = buildSectionText(section, fd);
    if (text) {
      props[section.title] = { rich_text: richText(text) };
    }
  }

  return props;
}

// ============================================
// Notion — Create a page in the database
// ============================================

async function createNotionPage(properties) {
  const body = {
    parent: { database_id: CONFIG.notion.databaseId },
    properties,
  };

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.notion.token}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Notion page creation failed: ${res.status} ${errText}`);
  }
  return res.json();
}

// ============================================
// Dry-run preview
// ============================================

function printPreview(row) {
  const fd = row.form_data || {};
  const name = row.full_name || fd.fullName || 'Unknown';
  const email = row.email || fd.email || '';
  const org = row.organization || fd.organization || '';
  const country = resolveLabel('country', row.country || fd.country);
  const social = row.social_profile || fd.socialProfile || '';

  const w = PREVIEW_WIDTH;
  const line = '─'.repeat(w);
  const wrap = (s) => {
    const lines = [];
    while (s.length > w - 4) {
      lines.push(s.substring(0, w - 4));
      s = s.substring(w - 4);
    }
    lines.push(s);
    return lines;
  };

  console.log(`  ┌${line}┐`);
  for (const l of wrap(`${name} — ${org}`)) {
    console.log(`  │ ${l.padEnd(w - 2)}│`);
  }
  for (const l of wrap(`${email} · ${country}`)) {
    console.log(`  │ ${l.padEnd(w - 2)}│`);
  }
  if (social) {
    for (const l of wrap(social)) {
      console.log(`  │ ${l.padEnd(w - 2)}│`);
    }
  }

  for (const section of SECTIONS) {
    if (section.title === 'Contact Information') continue;
    const text = buildSectionText(section, fd);
    if (!text) continue;

    console.log(`  ├${line}┤`);
    console.log(`  │ ${section.title.padEnd(w - 2)}│`);
    console.log(`  ├${line}┤`);
    for (const sLine of text.split('\n')) {
      for (const wl of wrap(sLine)) {
        console.log(`  │ ${wl.padEnd(w - 2)}│`);
      }
    }
  }
  console.log(`  └${line}┘`);
}

// ============================================
// Main
// ============================================

async function main() {
  console.log('RLDX Waitlist → Notion Sync');
  console.log('===========================\n');

  if (DRY_RUN) console.log('[DRY RUN — no Notion pages will be created]\n');

  // Show extracted structure
  console.log('Form structure (auto-extracted from index.html):');
  for (const s of SECTIONS) {
    const fieldKeys = s.fields.filter(f => !f.key.endsWith('Other') && !PROFILE_KEYS.includes(f.key)).map(f => f.key);
    if (s.title === 'Contact Information') {
      console.log(`  ${s.title}: [profile columns]`);
    } else {
      console.log(`  ${s.title}: ${fieldKeys.join(', ')}`);
    }
  }
  console.log('');

  // Step 1: Fetch from Supabase
  console.log('Fetching Supabase rows...');
  const rows = await fetchSupabaseRows();
  console.log(`  Found ${rows.length} total submissions.\n`);

  if (rows.length === 0) {
    console.log('Nothing to sync.');
    return;
  }

  // Step 2: Ensure Notion DB has section columns
  if (!DRY_RUN) {
    console.log('Ensuring Notion columns exist...');
    await ensureSectionColumns();
  }

  // Step 3: Check existing Notion entries
  console.log('Checking existing Notion entries...');
  const existingEmails = DRY_RUN ? new Set() : await getExistingEmails();
  console.log(`  Found ${existingEmails.size} already synced.\n`);

  // Step 3: Filter new rows
  const newRows = rows.filter(r => !existingEmails.has((r.email || '').toLowerCase()));
  console.log(`  ${newRows.length} new entries to sync.\n`);

  if (newRows.length === 0) {
    console.log('Everything is up to date!');
    return;
  }

  // Step 4: Create Notion pages
  let created = 0;
  let failed = 0;

  for (const row of newRows) {
    const name = row.full_name || row.form_data?.fullName || 'Unknown';
    const email = row.email || '';

    try {
      const properties = buildProperties(row);

      if (DRY_RUN) {
        printPreview(row);
        console.log('');
        created++;
        continue;
      }

      await createNotionPage(properties);
      console.log(`  ✓ Created: ${name} (${email})`);
      created++;

      await new Promise(resolve => setTimeout(resolve, NOTION_RATE_LIMIT_DELAY));
    } catch (err) {
      console.error(`  ✗ Failed: ${name} (${email}) — ${err.message}`);
      failed++;
    }
  }

  // Summary
  console.log('\n===========================');
  console.log(`Done! Created: ${created}, Failed: ${failed}, Skipped: ${existingEmails.size}`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
