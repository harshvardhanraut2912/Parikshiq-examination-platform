// components/admin/adminNav.js  (new file)
//
// Single source of truth for the admin sidebar. These are DEMO entries for now:
// each one already has its own URL (/admin/<slug>) so the left sidebar can be
// clicked and the right-hand screen swaps, but the real pages get built later.
// slug "" = Overview (the admin homepage, shown by default).
//
// To add a real page later: add an entry here, then create app/admin/<slug>/page.js
// (a real folder always wins over the generic placeholder at app/admin/[panel]).

export const NAV_GROUPS = [
  {
    label: "Main",
    items: [{ slug: "", label: "Overview", icon: "grid" }],
  },
  {
    label: "Academics",
    items: [
      { slug: "students", label: "Students", icon: "users" },
      { slug: "courses", label: "Courses", icon: "book" },
      { slug: "study-material", label: "Study Material", icon: "folder" },
      { slug: "exams", label: "Exams", icon: "clipboard" },
      { slug: "question-bot", label: "Question Bot", icon: "bot" },
      { slug: "performance", label: "Performance", icon: "chart" },
    ],
  },
  {
    label: "Administration",
    items: [
      { slug: "payments", label: "Payments", icon: "card" },
      { slug: "announcements", label: "Announcements", icon: "bell" },
      { slug: "inquiry-reports", label: "Inquiry Reports", icon: "mail" },
      { slug: "settings", label: "Settings", icon: "gear" },
    ],
  },
];

export const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

// Labels for second-level pages, shown in the top-bar breadcrumb ("Admin / Exams / Create Exam").
export const SUB_LABELS = {
  "exams/create": "Create Exam",
};
