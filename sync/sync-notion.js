#!/usr/bin/env node

/**
 * RLDX Waitlist → Notion Sync Script
 *
 * Fetches waitlist submissions from Supabase and creates
 * structured Notion pages with properties + detailed content.
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
const PREVIEW_WIDTH = 56;

// ============================================
// Label Maps — code → human-readable
// ============================================
const LABELS = {
  country: {
    US: 'United States', KR: 'South Korea', JP: 'Japan', CN: 'China',
    DE: 'Germany', UK: 'United Kingdom', CA: 'Canada', AU: 'Australia',
    SG: 'Singapore', other: 'Other',
  },
  affiliation: {
    academic: 'Academic', industry: 'Industry / Corporate', startup: 'Startup',
    investor: 'Investor / VC', media: 'Media / Content Creator',
    independent: 'Independent / Hobbyist', other: 'Other',
  },
  academicRole: {
    professor: 'Professor / Principal Investigator', postdoc: 'PhD / Postdoc / Researcher',
    student: 'Student (Undergrad / Masters)',
  },
  industryRole: {
    rd: 'R&D / Research', engineering: 'Engineering / Product',
    operations: 'Operations / Deployment', business: 'Business / Strategy',
  },
  startupRole: {
    founder: 'Founder / C-level', engineer: 'Engineer / Researcher', other: 'Other',
  },
  industry: {
    manufacturing: 'Manufacturing', logistics: 'Logistics / Warehousing',
    food: 'Food & Beverage', healthcare: 'Healthcare / Medical',
    retail: 'Retail / Service', automotive: 'Automotive',
    electronics: 'Electronics', aerospace: 'Aerospace',
    agriculture: 'Agriculture', construction: 'Construction', other: 'Other',
  },
  communities: {
    openarm: 'OpenArm', lerobot: 'LeRobot', huggingface: 'Hugging Face Robotics',
    ros: 'ROS Community', pai_social: 'Physical AI Discord / Twitter',
    none: 'None', other: 'Other',
  },
  robotAccess: {
    own: 'Owns/operates robots', lab: 'Through lab/company',
    planning: 'Planning to get one', interested: 'Just interested',
  },
  robotType: {
    humanoid: 'Humanoid (full-body)', bimanual: 'Bimanual Arm System',
    single_arm: 'Single Arm (6-7 DOF)', mobile: 'Mobile Manipulator',
    dexterous_hand: 'Dexterous Hand System', other: 'Other',
  },
  robotBrand: {
    aloha: 'ALOHA', franka: 'Franka', kuka: 'KUKA', ur: 'Universal Robots',
    unitree: 'Unitree', fourier: 'Fourier', agilex: 'AgileX', trossen: 'Trossen',
    lerobot_so100: 'LeRobot SO-100', rlwrld: 'RLWRLD ALLEX / OpenArm',
    custom: 'Custom-built', other: 'Other',
  },
  simAccess: {
    rtx4080_plus: 'RTX 4080+ (16GB+)', rtx4070: 'RTX 4070 (12-16GB)',
    lower: 'Lower-end GPU', cloud: 'Cloud only', no: 'No access',
  },
  useCase: {
    benchmark: 'Benchmark', finetune: 'Fine-tune', integrate: 'Integrate',
    deploy: 'Deploy', prototype: 'Prototype', hobby: 'Personal/Hobby',
    explore: 'Just explore',
  },
  applications: {
    bin_picking: 'Bin picking', assembly: 'Assembly', packaging: 'Packaging',
    tool_use: 'Tool use', handover: 'Object handover',
    cable: 'Cable manipulation', cloth: 'Cloth handling',
    food: 'Food handling', cleaning: 'Cleaning', door: 'Door/drawer',
    writing: 'Writing/drawing', other: 'Other',
  },
  shareWilling: { yes: 'Yes', maybe: 'Maybe', no: 'No' },
  shareType: {
    content: 'Create content (video/blog/social)',
    testimonial: 'Testimonial at launch event',
  },
  eventAttendance: {
    us_inperson: 'In person (US) - May 2026 (Tentative)', kr_inperson: 'In person (Korea) - June 2026 (Tentative)',
    jp_inperson: 'In person (Japan) - May 2026 (Tentative)', virtual: 'Virtual',
    maybe: 'Maybe', no: 'No',
  },
  referralSource: {
    social: 'Social media', news: 'News / Conference',
    word_of_mouth: 'Word of mouth', website: 'RLWRLD website', other: 'Other',
  },
};

// ============================================
// Helpers
// ============================================

/** Normalize value to array (handles single string or array) */
function toArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

/** Look up label, fall back to raw code */
function label(map, code) {
  if (!code) return '';
  return map[code] || code;
}

/** Map an array of codes to labels */
function labelArray(map, codes) {
  return toArray(codes).map(c => label(map, c)).filter(Boolean);
}

/** Derive the role text based on affiliation */
function deriveRole(fd) {
  const aff = fd.affiliation;
  if (aff === 'academic') {
    const r = label(LABELS.academicRole, fd.academicRole);
    return r || '';
  }
  if (aff === 'industry') {
    const r = label(LABELS.industryRole, fd.industryRole);
    return r || '';
  }
  if (aff === 'startup') {
    let r = label(LABELS.startupRole, fd.startupRole);
    if (fd.startupRole === 'other' && fd.startupRoleOther) {
      r = fd.startupRoleOther;
    }
    return r || '';
  }
  return '';
}

/** Create a Notion rich_text array from a string */
function richText(content) {
  return [{ type: 'text', text: { content: content || '' } }];
}

/** Create a bold + normal rich_text pair: "Label: Value" */
function labelValue(lbl, val) {
  return [
    { type: 'text', text: { content: `${lbl}: ` }, annotations: { bold: true } },
    { type: 'text', text: { content: val || '—' } },
  ];
}

/** Create a heading_2 block */
function heading2(text) {
  return {
    object: 'block', type: 'heading_2',
    heading_2: { rich_text: richText(text) },
  };
}

/** Create a bulleted_list_item block */
function bullet(richTextArr) {
  return {
    object: 'block', type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: richTextArr },
  };
}

/** Create a divider block */
function divider() {
  return { object: 'block', type: 'divider', divider: {} };
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
    'Country': { select: { name: label(LABELS.country, row.country || fd.country) || 'Other' } },
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

  return props;
}

// ============================================
// Transform — Supabase row → Notion page content
// ============================================

function buildBackgroundSection(fd) {
  const blocks = [];
  blocks.push(heading2('Background'));
  let affText = label(LABELS.affiliation, fd.affiliation);
  if (fd.affiliation === 'other' && fd.affiliationOther) {
    affText = `Other: ${fd.affiliationOther}`;
  }
  blocks.push(bullet(labelValue('Affiliation', affText)));

  const role = deriveRole(fd);
  if (role) {
    blocks.push(bullet(labelValue('Role', role)));
  }

  if (fd.affiliation === 'industry') {
    const industries = labelArray(LABELS.industry, fd.industry);
    if (fd.industryOther) industries.push(fd.industryOther);
    if (industries.length > 0) {
      blocks.push(bullet(labelValue('Industries', industries.join(', '))));
    }
  }

  const communities = labelArray(LABELS.communities, fd.communities);
  if (fd.communitiesOther) communities.push(fd.communitiesOther);
  if (communities.length > 0) {
    blocks.push(bullet(labelValue('Communities', communities.join(', '))));
  }
  return blocks;
}

function buildHardwareSection(fd) {
  const blocks = [];
  blocks.push(heading2('Hardware'));
  blocks.push(bullet(labelValue('Robot Access', label(LABELS.robotAccess, fd.robotAccess))));

  const hasRobot = ['own', 'lab', 'planning'].includes(fd.robotAccess);
  if (hasRobot) {
    const types = labelArray(LABELS.robotType, fd.robotType);
    if (fd.robotTypeOther) types.push(fd.robotTypeOther);
    if (types.length > 0) {
      blocks.push(bullet(labelValue('Robot Types', types.join(', '))));
    }

    const brands = labelArray(LABELS.robotBrand, fd.robotBrand);
    if (fd.robotBrandOther) brands.push(fd.robotBrandOther);
    if (brands.length > 0) {
      blocks.push(bullet(labelValue('Robot Brands', brands.join(', '))));
    }
  }

  blocks.push(bullet(labelValue('Simulation', label(LABELS.simAccess, fd.simAccess))));
  return blocks;
}

function buildInterestSection(fd) {
  const blocks = [];
  blocks.push(heading2('Interest'));
  const useCases = labelArray(LABELS.useCase, fd.useCase);
  blocks.push(bullet(labelValue('Use Cases', useCases.join(', ') || '—')));

  const apps = labelArray(LABELS.applications, fd.applications);
  if (fd.applicationsOther) apps.push(fd.applicationsOther);
  blocks.push(bullet(labelValue('Tasks', apps.join(', ') || '—')));

  let shareText = label(LABELS.shareWilling, fd.shareWilling);
  if (fd.shareWilling === 'yes') {
    const shareTypes = labelArray(LABELS.shareType, fd.shareType);
    if (shareTypes.length > 0) {
      shareText += ` → ${shareTypes.join(', ')}`;
    }
  }
  blocks.push(bullet(labelValue('Share', shareText)));
  return blocks;
}

function buildEngagementSection(fd) {
  const blocks = [];
  blocks.push(heading2('Engagement'));
  blocks.push(bullet(labelValue('Event', label(LABELS.eventAttendance, fd.eventAttendance))));

  let referralText = label(LABELS.referralSource, fd.referralSource);
  if (fd.referralSource === 'other' && fd.referralSourceOther) {
    referralText = `Other: ${fd.referralSourceOther}`;
  }
  blocks.push(bullet(labelValue('Referral', referralText)));
  return blocks;
}

function buildPageContent(row) {
  const fd = row.form_data || {};
  return [
    ...buildBackgroundSection(fd),
    divider(),
    ...buildHardwareSection(fd),
    divider(),
    ...buildInterestSection(fd),
    divider(),
    ...buildEngagementSection(fd),
  ];
}

// ============================================
// Notion — Create a page in the database
// ============================================

async function createNotionPage(properties, children) {
  const body = {
    parent: { database_id: CONFIG.notion.databaseId },
    properties,
    children,
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
// Dry-run preview — terminal-formatted profile
// ============================================

function printPreview(row) {
  const fd = row.form_data || {};
  const name = row.full_name || fd.fullName || 'Unknown';
  const email = row.email || fd.email || '';
  const org = row.organization || fd.organization || '';
  const country = label(LABELS.country, row.country || fd.country);
  const social = row.social_profile || fd.socialProfile || '';

  let affText = label(LABELS.affiliation, fd.affiliation);
  if (fd.affiliation === 'other' && fd.affiliationOther) affText = `Other: ${fd.affiliationOther}`;
  const role = deriveRole(fd);

  const robotText = label(LABELS.robotAccess, fd.robotAccess);
  const hasRobot = ['own', 'lab', 'planning'].includes(fd.robotAccess);
  const brands = hasRobot ? labelArray(LABELS.robotBrand, fd.robotBrand) : [];
  if (hasRobot && fd.robotBrandOther) brands.push(fd.robotBrandOther);
  const types = hasRobot ? labelArray(LABELS.robotType, fd.robotType) : [];
  if (hasRobot && fd.robotTypeOther) types.push(fd.robotTypeOther);

  const sim = label(LABELS.simAccess, fd.simAccess);
  const useCases = labelArray(LABELS.useCase, fd.useCase);
  const apps = labelArray(LABELS.applications, fd.applications);
  if (fd.applicationsOther) apps.push(fd.applicationsOther);
  const event = label(LABELS.eventAttendance, fd.eventAttendance);

  let referral = label(LABELS.referralSource, fd.referralSource);
  if (fd.referralSource === 'other' && fd.referralSourceOther) referral = fd.referralSourceOther;

  const share = label(LABELS.shareWilling, fd.shareWilling);
  const communities = labelArray(LABELS.communities, fd.communities);
  if (fd.communitiesOther) communities.push(fd.communitiesOther);

  const w = PREVIEW_WIDTH;
  const line = '─'.repeat(w);
  const pad = (s) => s + ' '.repeat(Math.max(0, w - 2 - s.length));

  console.log(`  ┌${line}┐`);
  console.log(`  │ ${pad(`${name} — ${org}`)}│`);
  console.log(`  │ ${pad(`${email} · ${country}`)}│`);
  if (social) console.log(`  │ ${pad(social)}│`);
  console.log(`  ├${line}┤`);
  console.log(`  │ ${pad(`Affiliation: ${affText}${role ? ' → ' + role : ''}`)}│`);
  if (communities.length) console.log(`  │ ${pad(`Communities: ${communities.join(', ')}`)}│`);
  console.log(`  ├${line}┤`);
  console.log(`  │ ${pad(`Robot: ${robotText}`)}│`);
  if (types.length) console.log(`  │ ${pad(`  Types: ${types.join(', ')}`)}│`);
  if (brands.length) console.log(`  │ ${pad(`  Brands: ${brands.join(', ')}`)}│`);
  console.log(`  │ ${pad(`Sim: ${sim}`)}│`);
  console.log(`  ├${line}┤`);
  console.log(`  │ ${pad(`Use Cases: ${useCases.join(', ') || '—'}`)}│`);
  console.log(`  │ ${pad(`Tasks: ${apps.join(', ') || '—'}`)}│`);
  console.log(`  │ ${pad(`Share: ${share} | Event: ${event}`)}│`);
  console.log(`  │ ${pad(`Referral: ${referral}`)}│`);
  console.log(`  └${line}┘`);
}

// ============================================
// Main
// ============================================

async function main() {
  console.log('RLDX Waitlist → Notion Sync');
  console.log('===========================\n');

  if (DRY_RUN) console.log('[DRY RUN — no Notion pages will be created]\n');

  // Step 1: Fetch from Supabase
  console.log('Fetching Supabase rows...');
  const rows = await fetchSupabaseRows();
  console.log(`  Found ${rows.length} total submissions.\n`);

  if (rows.length === 0) {
    console.log('Nothing to sync.');
    return;
  }

  // Step 2: Check existing Notion entries
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
      const children = buildPageContent(row);

      if (DRY_RUN) {
        printPreview(row);
        created++;
        continue;
      }

      await createNotionPage(properties, children);
      console.log(`  ✓ Created: ${name} (${email})`);
      created++;

      // Small delay to respect Notion rate limits (3 req/sec)
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
