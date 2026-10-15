import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// Starter templates for the start page. Each builds a real PDF in memory, so
// it goes through exactly the same load/edit/export path as an opened file.

const PAGE_W = 612, PAGE_H = 792, MARGIN = 54;

const RESUME_CLASSIC = {
  name: 'FIRST LAST',
  contact: 'City, State • +1-234-456-7890 • youremail@example.com • linkedin.com/in/username',
  summary: 'Results-driven professional with several years of experience designing and delivering solutions for complex business problems. Skilled in [Skill 1] and [Skill 2], with a record of measurable impact.',
  jobs: [
    {
      org: 'Company Name', place: 'New York, NY', title: 'Job Title', dates: 'Jun 2020 – Present',
      bullets: [
        'Increased revenue and customer growth by 25% over two years by analyzing business needs and collaborating with stakeholders.',
        'Led a team of 10 on initiatives that reduced operating costs by 20% and created new customer-facing options.',
        'Designed and developed a platform for processing customer preferences using [Tool 1], [Tool 2], and [Tool 3].',
      ],
    },
    {
      org: 'Company Name', place: 'New York, NY', title: 'Job Title', dates: 'Jan 2016 – May 2020',
      bullets: [
        'Worked closely with 15 teams across the company to identify and solve business challenges.',
        'Developed a new pricing strategy that boosted margins by 4 percent.',
        'Automated manual processes across millions of records, reducing workload by 25% monthly.',
      ],
    },
    {
      org: 'Company Name', place: 'San Diego, CA', title: 'Job Title', dates: 'May 2012 – Dec 2015',
      bullets: [
        'Built a data pipeline that ingested transactional data from an app with 5,000 daily active users.',
        'Worked with clients to understand business needs and convert them into actionable reports, saving 10 hours of manual work each week.',
      ],
    },
  ],
  education: {
    org: 'University Name', place: 'City, ST', dates: 'May 2012',
    line: 'B.S. in Your Major, Minor in Your Minor',
    bullets: ['Awards: Dean’s List, Teaching Fellow', 'Completed a one-year study abroad program'],
  },
  other: [
    ['Skills:', ' Skill One, Skill Two, Skill Three, Skill Four, Skill Five'],
    ['Volunteering:', ' 20 hours/month at an organization you care about'],
    ['Projects:', ' A short description of a project and its result'],
  ],
};

async function buildResume() {
  const t = RESUME_CLASSIC;
  const doc = await PDFDocument.create();
  doc.setTitle('Resume');
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const reg = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const right = PAGE_W - MARGIN;
  const BODY = 10, LEAD = 12.2, INDENT = 40, BULLET_TEXT_X = MARGIN + 28;
  const black = rgb(0, 0, 0);
  let y = PAGE_H - MARGIN - 6;

  const text = (s, x, size = BODY, font = reg) => page.drawText(s, { x, y, size, font, color: black });
  const textRight = (s, size = BODY, font = reg) => text(s, right - font.widthOfTextAtSize(s, size), size, font);
  const textCentered = (s, size, font = reg) => text(s, (PAGE_W - font.widthOfTextAtSize(s, size)) / 2, size, font);
  const rule = (yy) => page.drawLine({ start: { x: MARGIN, y: yy }, end: { x: right, y: yy }, thickness: 0.8, color: black });

  const wrap = (s, font, size, maxW) => {
    const lines = []; let cur = '';
    for (const word of s.split(' ')) {
      const next = cur ? `${cur} ${word}` : word;
      if (cur && font.widthOfTextAtSize(next, size) > maxW) { lines.push(cur); cur = word; } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines;
  };
  const paragraph = (s, x) => {
    for (const ln of wrap(s, reg, BODY, right - x)) { text(ln, x); y -= LEAD; }
  };
  const bulletList = (items) => {
    for (const b of items) {
      text('•', MARGIN + 14);
      for (const ln of wrap(b, reg, BODY, right - BULLET_TEXT_X)) { text(ln, BULLET_TEXT_X); y -= LEAD; }
    }
  };
  const section = (title) => {
    y -= 8;
    text(title, MARGIN, 11, bold);
    rule(y - 3);
    y -= 17;
  };
  // "Org, Place" (org bold) with dates right-aligned, then an optional line.
  const heading = (org, place, dates) => {
    text(org, MARGIN, BODY + 0.5, bold);
    text(`, ${place}`, MARGIN + bold.widthOfTextAtSize(org, BODY + 0.5), BODY + 0.5);
    textRight(dates);
    y -= LEAD;
  };

  textCentered(t.name, 20, bold); y -= 15;
  textCentered(t.contact, 8.5); y -= 10;

  section('SUMMARY');
  paragraph(t.summary, MARGIN);

  section('PROFESSIONAL EXPERIENCE');
  t.jobs.forEach((j, i) => {
    heading(j.org, j.place, j.dates);
    text(j.title, MARGIN, BODY, bold); y -= LEAD;
    bulletList(j.bullets);
    if (i < t.jobs.length - 1) y -= 6;
  });

  section('EDUCATION');
  heading(t.education.org, t.education.place, t.education.dates);
  text(t.education.line, MARGIN); y -= LEAD;
  bulletList(t.education.bullets);

  section('SKILLS & OTHER');
  for (const [label, rest] of t.other) {
    text(label, MARGIN, BODY, bold);
    const x0 = MARGIN + bold.widthOfTextAtSize(label, BODY);
    const [first, ...more] = wrap(rest.trim(), reg, BODY, right - x0 - 3);
    text(` ${first}`, x0); y -= LEAD;
    for (const ln of more) { text(ln, MARGIN); y -= LEAD; }
  }

  return doc.save();
}


// ---- shared helpers for the sans-serif / letter templates ----
function wrapLines(s, font, size, maxW) {
  const lines = []; let cur = '';
  for (const word of s.split(' ')) {
    const next = cur ? `${cur} ${word}` : word;
    if (cur && font.widthOfTextAtSize(next, size) > maxW) { lines.push(cur); cur = word; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

async function buildResumeModern() {
  const doc = await PDFDocument.create();
  doc.setTitle('Resume');
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const right = PAGE_W - MARGIN;
  const BODY = 9.5, LEAD = 12.4;
  const ink = rgb(0.1, 0.1, 0.12), accent = rgb(0.12, 0.25, 0.55), grey = rgb(0.38, 0.38, 0.42);
  let y = PAGE_H - MARGIN - 8;
  const text = (s, x, size = BODY, font = reg, color = ink) => page.drawText(s, { x, y, size, font, color });
  const textRight = (s, size = BODY, font = reg, color = grey) => text(s, right - font.widthOfTextAtSize(s, size), size, font, color);
  const bullets = (items) => {
    for (const b of items) {
      text('\u2022', MARGIN + 6);
      for (const ln of wrapLines(b, reg, BODY, right - MARGIN - 20)) { text(ln, MARGIN + 18); y -= LEAD; }
    }
  };
  const section = (title) => {
    y -= 10;
    text(title, MARGIN, 10.5, bold, accent);
    page.drawLine({ start: { x: MARGIN, y: y - 4 }, end: { x: right, y: y - 4 }, thickness: 0.6, color: accent });
    y -= 19;
  };
  const entry = (title, org, dates, items) => {
    text(title, MARGIN, 10, bold);
    textRight(dates);
    y -= LEAD;
    text(org, MARGIN, BODY, reg, grey); y -= LEAD;
    bullets(items);
    y -= 5;
  };

  text('Your Name', MARGIN, 26, bold); y -= 18;
  text('Software Engineer', MARGIN, 12, reg, accent); y -= 16;
  text('City, ST  |  youremail@example.com  |  +1 234 456 7890  |  linkedin.com/in/username  |  yoursite.com', MARGIN, 8.5, reg, grey); y -= 6;

  section('PROFILE');
  for (const ln of wrapLines('Engineer who ships reliable products end to end. Strong in [Language 1] and [Language 2], with experience owning features from design through launch and measuring the results.', reg, BODY, right - MARGIN)) { text(ln, MARGIN); y -= LEAD; }

  section('EXPERIENCE');
  entry('Job Title', 'Company Name, City, ST', 'Jun 2023 - Present', [
    'Led the redesign of a core product feature, improving task completion by 30% across 50,000 monthly users.',
    'Cut page load time by 40% by profiling bottlenecks and introducing caching and code-splitting.',
    'Mentored two junior engineers and ran weekly code reviews for a team of eight.',
  ]);
  entry('Job Title', 'Company Name, City, ST', 'Jan 2021 - May 2023', [
    'Built internal tooling in [Tool 1] and [Tool 2] that saved the team 10 hours of manual work each week.',
    'Partnered with design and product to scope, estimate and deliver quarterly roadmap items on schedule.',
  ]);

  section('PROJECTS');
  entry('Project Name', '[Tech 1], [Tech 2], [Tech 3]', '2024', [
    'One sentence on what it does and who uses it, followed by a measurable result.',
  ]);

  section('EDUCATION');
  entry('B.S. in Your Major', 'University Name, City, ST', 'May 2020', ['Dean\u2019s List, relevant coursework: Algorithms, Databases, Operating Systems']);

  section('SKILLS');
  text('Languages', MARGIN, BODY, bold); text('Skill One, Skill Two, Skill Three, Skill Four', MARGIN + 80); y -= LEAD;
  text('Tools', MARGIN, BODY, bold); text('Tool One, Tool Two, Tool Three, Tool Four', MARGIN + 80); y -= LEAD;

  return doc.save();
}

async function buildCoverLetter() {
  const doc = await PDFDocument.create();
  doc.setTitle('Cover Letter');
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const reg = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const right = PAGE_W - 72, left = 72;
  const BODY = 11, LEAD = 15;
  const black = rgb(0, 0, 0), grey = rgb(0.35, 0.35, 0.35);
  let y = PAGE_H - 72;
  const text = (s, x = left, size = BODY, font = reg, color = black) => page.drawText(s, { x, y, size, font, color });
  const line = (s, font = reg, color = black) => { text(s, left, BODY, font, color); y -= LEAD; };
  const para = (s) => { for (const ln of wrapLines(s, reg, BODY, right - left)) line(ln); y -= 8; };

  text('Your Name', left, 18, bold); y -= 18;
  text('City, ST  |  youremail@example.com  |  +1 234 456 7890', left, 9.5, reg, grey); y -= 6;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.8, color: black });
  y -= 30;

  line('Month Day, Year');
  y -= 10;
  line('Hiring Manager Name');
  line('Company Name');
  line('Street Address');
  line('City, ST 00000');
  y -= 12;

  line('Dear Hiring Manager Name,');
  y -= 6;
  para('I am excited to apply for the [Job Title] position at [Company Name]. With [X years] of experience in [your field], I have built a track record of delivering [type of results] and I would welcome the chance to bring that to your team.');
  para('In my current role at [Company], I [key accomplishment with a measurable result]. I also [second accomplishment], which taught me [skill relevant to the role]. These experiences line up closely with what you are looking for in this position.');
  para('What draws me to [Company Name] is [specific reason: a product, mission or value]. I am eager to contribute my skills in [Skill 1] and [Skill 2] while continuing to grow alongside your team.');
  para('Thank you for your time and consideration. I would love to discuss how I can contribute and can be reached at youremail@example.com or +1 234 456 7890.');
  y -= 4;
  line('Sincerely,');
  y -= 22;
  line('Your Name', bold);

  return doc.save();
}

export const TEMPLATES = [
  { id: 'resume-classic', name: 'Resume', subtitle: 'Classic', fileName: 'Resume.pdf', build: buildResume },
  { id: 'resume-modern', name: 'Resume', subtitle: 'Modern', fileName: 'Resume-Modern.pdf', build: buildResumeModern },
  { id: 'cover-letter', name: 'Cover Letter', subtitle: 'Standard', fileName: 'Cover-Letter.pdf', build: buildCoverLetter },
];

export async function buildTemplateFile(template) {
  const bytes = await template.build();
  return new File([bytes], template.fileName, { type: 'application/pdf' });
}
