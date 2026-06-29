import { baseProfileSchema, jobDescriptionSchema, type BaseProfile, type JobDescription } from "@cv-tailor/shared";

export type SyntheticExpectation = {
  fit: "direct" | "adjacent" | "stretch";
  seniority: "junior" | "mid" | "senior" | "executive";
  jobFamily: string;
  positioningMode: "target-identity" | "adjacent-identity" | "transition" | "transferable" | "education-led" | "executive";
  requiredSummaryTerms: string[];
  requiredAnyGroups?: string[][];
  forbiddenClaims: string[];
  inferencePolicy: "none" | "allow-with-warning";
  pageTarget: "one" | "two";
};

export type SyntheticCase = {
  id: string;
  label: string;
  profile: BaseProfile;
  job: JobDescription;
  expectation: SyntheticExpectation;
};

const updatedAt = "2026-06-23T00:00:00.000Z";

function profile(input: Partial<BaseProfile> & Pick<BaseProfile, "id" | "contact" | "targetRole" | "summary">): BaseProfile {
  return baseProfileSchema.parse({
    outputLanguage: "en",
    experiences: [],
    education: [],
    projects: [],
    skills: [],
    skillCategories: {},
    certifications: [],
    languages: [],
    sectionOrder: [],
    style: { preset: "times" },
    dismissedChecks: [],
    rawText: "",
    updatedAt,
    ...input
  });
}

function job(input: Omit<JobDescription, "source" | "url"> & Partial<Pick<JobDescription, "source" | "url">>): JobDescription {
  return jobDescriptionSchema.parse({ source: "manual", url: "", ...input });
}

export const syntheticCases: SyntheticCase[] = [
  {
    id: "synthetic-backend-direct-01",
    label: "Direct technical fit",
    profile: profile({
      id: "profile-backend",
      contact: { name: "Sofia Marin", email: "sofia.marin@example.com", phone: "", location: "Madrid, Spain", linkedIn: "" },
      targetRole: "Backend Engineer",
      summary: "Software developer focused on reliable APIs and repeatable delivery.",
      experiences: [{
        id: "backend-role",
        company: "Northstar Labs",
        role: "Software Developer",
        startDate: "Jan 2022",
        endDate: "Present",
        bullets: [
          "Built TypeScript APIs used by 12 internal product teams.",
          "Reduced deployment time by 25% through CI/CD automation.",
          "Designed API contracts and PostgreSQL data models for customer workflows.",
          "Improved service reliability through automated integration testing."
        ]
      }],
      education: [{ id: "backend-edu", school: "Universidad Carlos III", degree: "BSc Computer Science", location: "Madrid, Spain", graduationDate: "2021", gpa: "", honors: "", coursework: [] }],
      skills: ["TypeScript", "API Design", "PostgreSQL", "CI/CD", "Integration Testing"],
      skillCategories: { Engineering: ["TypeScript", "API Design", "PostgreSQL", "CI/CD", "Integration Testing"] },
      rawText: "Software Developer. Built TypeScript APIs used by 12 teams and automated CI/CD."
    }),
    job: job({
      title: "Backend Engineer",
      company: "Harbor Systems",
      location: "Remote, Spain",
      description: "Build TypeScript backend services, design APIs, work with PostgreSQL, and improve CI/CD reliability. Three years of backend delivery experience preferred."
    }),
    expectation: {
      fit: "direct", seniority: "mid", jobFamily: "technical", positioningMode: "target-identity",
      requiredSummaryTerms: ["TypeScript", "API"], requiredAnyGroups: [["CI/CD", "deployment"]],
      forbiddenClaims: ["Kubernetes", "managed engineers", "40%"], inferencePolicy: "none", pageTarget: "one"
    }
  },
  {
    id: "synthetic-treasury-adjacent-02",
    label: "Same-profession specialization",
    profile: profile({
      id: "profile-treasury",
      contact: { name: "Luca Bianchi", email: "luca.bianchi@example.com", phone: "", location: "Milan, Italy", linkedIn: "" },
      targetRole: "Finance Analyst",
      summary: "Finance associate experienced in AR/AP operations, reconciliations, and cash-flow support.",
      experiences: [{
        id: "finance-role",
        company: "Orion Components",
        role: "Finance Associate",
        startDate: "Mar 2023",
        endDate: "Present",
        bullets: [
          "Reconciled bank and customer accounts across 4 European entities.",
          "Prepared weekly cash-position reports supporting short-term liquidity decisions.",
          "Processed supplier payments and resolved rejected transactions.",
          "Investigated intercompany balance differences before month-end close."
        ]
      }],
      education: [{ id: "finance-edu", school: "University of Milan", degree: "BSc Economics", location: "Milan, Italy", graduationDate: "2022", gpa: "", honors: "", coursework: [] }],
      skills: ["Cash Flow Reporting", "Bank Reconciliation", "Accounts Payable", "Intercompany Reconciliation", "Excel"],
      skillCategories: { Finance: ["Cash Flow Reporting", "Bank Reconciliation", "Accounts Payable", "Intercompany Reconciliation"], Tools: ["Excel"] }
    }),
    job: job({
      title: "Treasury Analyst",
      company: "Meridian Analytics",
      location: "Milan, Italy",
      description: "Support payment processing, cash-flow forecasting, bank reconciliation, intercompany funding, treasury reporting, and banking-query resolution in an international team."
    }),
    expectation: {
      fit: "adjacent", seniority: "junior", jobFamily: "finance", positioningMode: "adjacent-identity",
      requiredSummaryTerms: ["cash"], requiredAnyGroups: [["reconciliation", "payment"]],
      forbiddenClaims: ["worked as a Treasury Analyst", "treasury department experience"], inferencePolicy: "none", pageTarget: "one"
    }
  },
  {
    id: "synthetic-aml-transition-03",
    label: "Functional career change",
    profile: profile({
      id: "profile-aml-transition",
      contact: { name: "Maya Brooks", email: "maya.brooks@example.com", phone: "", location: "Dublin, Ireland", linkedIn: "" },
      targetRole: "Operations Analyst",
      summary: "Operations analyst experienced in exception investigation, controls, and documented case resolution.",
      experiences: [{
        id: "ops-role",
        company: "ParcelGrid",
        role: "Operations Analyst",
        startDate: "Jun 2022",
        endDate: "Present",
        bullets: [
          "Investigated 45-60 daily transaction and identity-data exceptions against documented controls.",
          "Escalated unusual account patterns with complete evidence trails to risk stakeholders.",
          "Maintained case notes and audit-ready process documentation.",
          "Reduced unresolved exceptions by 18% through root-cause categorization."
        ]
      }],
      education: [{ id: "ops-edu", school: "Dublin City University", degree: "BA Business Studies", location: "Dublin, Ireland", graduationDate: "2022", gpa: "", honors: "", coursework: [] }],
      skills: ["Case Investigation", "Exception Handling", "Internal Controls", "Audit Documentation", "Root-Cause Analysis"],
      skillCategories: { Operations: ["Case Investigation", "Exception Handling", "Root-Cause Analysis"], Controls: ["Internal Controls", "Audit Documentation"] }
    }),
    job: job({
      title: "KYC/AML Analyst",
      company: "ClearBanking",
      location: "Dublin, Ireland",
      description: "Review customer files, investigate unusual activity, maintain KYC evidence, escalate risk indicators, and support AML controls. Prior KYC experience is preferred but transferable investigation experience is considered."
    }),
    expectation: {
      fit: "adjacent", seniority: "mid", jobFamily: "compliance", positioningMode: "transition",
      requiredSummaryTerms: ["investigat"], requiredAnyGroups: [["transition", "targeting", "seeking"], ["controls", "evidence"]],
      forbiddenClaims: ["experienced KYC/AML Analyst", "AML investigations for"], inferencePolicy: "none", pageTarget: "one"
    }
  },
  {
    id: "synthetic-turkish-language-04",
    label: "Explicit language requirement",
    profile: profile({
      id: "profile-turkish",
      contact: { name: "Emre Kaya", email: "emre.kaya@example.com", phone: "", location: "Kraków, Poland", linkedIn: "" },
      targetRole: "Order Management Analyst",
      summary: "Customer operations specialist supporting order and billing workflows across EMEA.",
      experiences: [{
        id: "orders-role",
        company: "Atlas Homeware",
        role: "Customer Operations Specialist",
        startDate: "Feb 2023",
        endDate: "Present",
        bullets: [
          "Processed 70+ weekly customer orders across SAP order-to-cash workflows.",
          "Resolved billing and delivery discrepancies with sales and logistics teams.",
          "Maintained order accuracy above 98% across assigned accounts.",
          "Prepared weekly backlog and fulfillment reports in Excel."
        ]
      }],
      education: [{ id: "orders-edu", school: "Istanbul University", degree: "BBA", location: "Istanbul, Türkiye", graduationDate: "2022", gpa: "", honors: "", coursework: [] }],
      skills: ["Order Management", "SAP", "Excel", "Billing Resolution"],
      skillCategories: { Operations: ["Order Management", "Billing Resolution"], Tools: ["SAP", "Excel"] },
      languages: [{ language: "Turkish", level: "C1" }, { language: "English", level: "B2" }, { language: "Polish", level: "B1" }]
    }),
    job: job({
      title: "Turkish-speaking Order Management Analyst",
      company: "Nova Consumer Goods",
      location: "Kraków, Poland",
      description: "Manage order-to-cash requests in SAP, resolve customer order issues, report backlog status, and communicate with Turkish customers. Turkish C1 and English B2 are required."
    }),
    expectation: {
      fit: "direct", seniority: "junior", jobFamily: "operations", positioningMode: "target-identity",
      requiredSummaryTerms: ["Turkish", "C1"], requiredAnyGroups: [["SAP", "order"]],
      forbiddenClaims: ["native Turkish"], inferencePolicy: "none", pageTarget: "one"
    }
  },
  {
    id: "synthetic-acca-certification-05",
    label: "Regulated certification requirement",
    profile: profile({
      id: "profile-acca",
      contact: { name: "Nina Patel", email: "nina.patel@example.com", phone: "", location: "London, UK", linkedIn: "" },
      targetRole: "Financial Reporting Associate",
      summary: "Junior accountant supporting reconciliations, journals, and statutory reporting preparation.",
      experiences: [{
        id: "acca-role",
        company: "Elmwood Services",
        role: "Junior Accountant",
        startDate: "Sep 2023",
        endDate: "Present",
        bullets: [
          "Prepared balance-sheet reconciliations and supporting schedules for month-end close.",
          "Posted journals and investigated ledger variances.",
          "Prepared audit support files for external review.",
          "Assisted with IFRS financial-statement disclosures."
        ]
      }],
      education: [{ id: "acca-edu", school: "University of Leicester", degree: "BSc Accounting and Finance", location: "Leicester, UK", graduationDate: "2023", gpa: "", honors: "", coursework: [] }],
      skills: ["Financial Reporting", "Balance Sheet Reconciliation", "Journal Entries", "IFRS", "Audit Support"],
      skillCategories: { Accounting: ["Financial Reporting", "Balance Sheet Reconciliation", "Journal Entries", "IFRS", "Audit Support"] },
      certifications: ["ACCA Applied Knowledge papers completed; Applied Skills in progress"]
    }),
    job: job({
      title: "Financial Reporting Associate",
      company: "Keystone Funds",
      location: "London, UK",
      description: "Prepare financial statements, reconciliations, and audit files under IFRS. Candidates should be ACCA part-qualified or actively progressing through ACCA examinations."
    }),
    expectation: {
      fit: "direct", seniority: "junior", jobFamily: "finance", positioningMode: "target-identity",
      requiredSummaryTerms: ["ACCA"], requiredAnyGroups: [["in progress", "progressing", "Applied Skills"]],
      forbiddenClaims: ["ACCA member", "fully qualified ACCA", "chartered accountant"], inferencePolicy: "none", pageTarget: "one"
    }
  },
  {
    id: "synthetic-healthcare-inference-06",
    label: "Industry inference",
    profile: profile({
      id: "profile-healthcare",
      contact: { name: "Ava Chen", email: "ava.chen@example.com", phone: "", location: "Boston, MA", linkedIn: "" },
      targetRole: "Commercial Analyst",
      summary: "Commercial analyst experienced in pricing, forecasting, and customer-performance reporting.",
      experiences: [{
        id: "health-role",
        company: "MediCore Devices",
        role: "Commercial Analyst",
        startDate: "Apr 2022",
        endDate: "Present",
        bullets: [
          "Built pricing and sales-performance reports for regional commercial leaders.",
          "Produced quarterly demand forecasts across 3 product portfolios.",
          "Analyzed customer profitability and contract discount trends.",
          "Automated monthly reporting in Power BI."
        ]
      }],
      education: [{ id: "health-edu", school: "Boston University", degree: "BA Economics", location: "Boston, MA", graduationDate: "2021", gpa: "", honors: "", coursework: [] }],
      skills: ["Commercial Analysis", "Pricing", "Forecasting", "Power BI", "Customer Profitability"],
      skillCategories: { Commercial: ["Commercial Analysis", "Pricing", "Forecasting", "Customer Profitability"], Tools: ["Power BI"] }
    }),
    job: job({
      title: "Healthcare Commercial Analyst",
      company: "WellSpring Health",
      location: "Boston, MA",
      description: "Support healthcare commercial strategy through pricing, forecasting, market performance, customer profitability, and Power BI reporting. Healthcare-sector exposure is preferred."
    }),
    expectation: {
      fit: "direct", seniority: "mid", jobFamily: "commercial", positioningMode: "target-identity",
      requiredSummaryTerms: ["pricing", "forecast"], forbiddenClaims: ["FDA", "clinical", "medical product launch"],
      inferencePolicy: "allow-with-warning", pageTarget: "one"
    }
  },
  {
    id: "synthetic-graduate-data-07",
    label: "Junior education-led profile",
    profile: profile({
      id: "profile-graduate",
      contact: { name: "Noah Williams", email: "noah.williams@example.com", phone: "", location: "Manchester, UK", linkedIn: "" },
      targetRole: "Junior Data Analyst",
      summary: "Recent statistics graduate with academic Python and dashboard projects.",
      experiences: [{
        id: "graduate-internship",
        company: "City Research Lab",
        role: "Data Intern",
        startDate: "Jun 2025",
        endDate: "Aug 2025",
        bullets: [
          "Cleaned survey datasets in Python and validated missing-value treatments.",
          "Built a Tableau dashboard summarizing 8,000 anonymized survey responses.",
          "Presented methodology and findings to a 6-person research team."
        ]
      }],
      education: [{ id: "graduate-edu", school: "University of Manchester", degree: "BSc Statistics", location: "Manchester, UK", graduationDate: "2026", gpa: "", honors: "First Class", coursework: ["Regression Analysis", "Data Visualization"] }],
      projects: [{ id: "graduate-project", title: "Public Transport Delay Dashboard", description: "Analyzed open transport data and built an interactive dashboard.", bullets: ["Processed 120,000 timetable records in Python.", "Compared route-level delay patterns."], technologies: ["Python", "pandas", "Tableau"] }],
      skills: ["Python", "pandas", "Tableau", "Data Cleaning", "Regression Analysis"],
      skillCategories: { Analytics: ["Python", "pandas", "Tableau", "Data Cleaning", "Regression Analysis"] }
    }),
    job: job({
      title: "Junior Data Analyst",
      company: "Urban Metrics",
      location: "Manchester, UK",
      description: "Clean and analyze datasets using Python, build Tableau dashboards, communicate findings, and apply statistical methods. Graduate and internship experience are welcome."
    }),
    expectation: {
      fit: "direct", seniority: "junior", jobFamily: "data", positioningMode: "education-led",
      requiredSummaryTerms: ["Statistics", "Python"], requiredAnyGroups: [["Tableau", "dashboard"]],
      forbiddenClaims: ["3 years", "professional data analyst"], inferencePolicy: "none", pageTarget: "one"
    }
  },
  {
    id: "synthetic-vp-commercial-08",
    label: "Executive direct fit",
    profile: profile({
      id: "profile-executive",
      contact: { name: "Elena Rossi", email: "elena.rossi@example.com", phone: "", location: "Rome, Italy", linkedIn: "" },
      targetRole: "VP Commercial",
      summary: "Regional commercial director leading multi-country revenue, teams, and P&L performance.",
      positioning: { level: "Executive", strategy: "Strategic Leader", notes: "" },
      experiences: [
        {
          id: "exec-role-1",
          company: "Aurora Foods",
          role: "Regional Sales Director",
          startDate: "Jan 2019",
          endDate: "Present",
          bullets: [
            "Owned a €180M regional P&L across 7 European markets.",
            "Led 65 sales and customer-development professionals through 6 country managers.",
            "Grew net revenue by 22% over 3 years while improving gross margin by 4 points.",
            "Negotiated joint business plans with the region's 12 largest retail customers.",
            "Repositioned route-to-market strategy across modern trade and e-commerce.",
            "Established quarterly commercial forecasting and performance reviews."
          ]
        },
        {
          id: "exec-role-2",
          company: "Aurora Foods",
          role: "Commercial Director",
          startDate: "Jan 2015",
          endDate: "Dec 2018",
          bullets: [
            "Directed a €75M national sales organization.",
            "Increased on-shelf availability from 91% to 97%.",
            "Reduced trade-spend leakage by €2.4M through governance controls.",
            "Built succession plans for 8 senior commercial leaders."
          ]
        }
      ],
      education: [{ id: "exec-edu", school: "LUISS Business School", degree: "MBA", location: "Rome, Italy", graduationDate: "2014", gpa: "", honors: "", coursework: [] }],
      skills: ["P&L Ownership", "Commercial Strategy", "Net Revenue Management", "Joint Business Planning", "Leadership", "Forecasting"],
      skillCategories: { Leadership: ["P&L Ownership", "Commercial Strategy", "Leadership"], Commercial: ["Net Revenue Management", "Joint Business Planning", "Forecasting"] }
    }),
    job: job({
      title: "Vice President, Commercial",
      company: "Summit Consumer Brands",
      location: "Rome, Italy",
      description: "Lead European commercial strategy, own regional P&L, accelerate profitable revenue growth, develop senior leaders, and manage strategic customer partnerships across multiple markets."
    }),
    expectation: {
      fit: "direct", seniority: "executive", jobFamily: "commercial", positioningMode: "executive",
      requiredSummaryTerms: ["€180M", "7"], requiredAnyGroups: [["22%", "revenue"], ["65", "team"]],
      forbiddenClaims: ["global P&L", "100 employees"], inferencePolicy: "none", pageTarget: "two"
    }
  },
  {
    id: "synthetic-manager-to-ic-09",
    label: "Down-level transition",
    profile: profile({
      id: "profile-downlevel",
      contact: { name: "Daniel Okafor", email: "daniel.okafor@example.com", phone: "", location: "Amsterdam, Netherlands", linkedIn: "" },
      targetRole: "Business Analyst",
      summary: "Operations manager combining process analysis, KPI reporting, and workflow improvement.",
      experiences: [{
        id: "downlevel-role",
        company: "FlowCart",
        role: "Operations Manager",
        startDate: "May 2020",
        endDate: "Present",
        bullets: [
          "Mapped fulfillment workflows and identified 14 process-control gaps.",
          "Built weekly KPI reporting for order accuracy, backlog, and cycle time.",
          "Reduced order exceptions by 21% through root-cause analysis and workflow redesign.",
          "Managed a 16-person operations team across two shifts."
        ]
      }],
      education: [{ id: "downlevel-edu", school: "University of Lagos", degree: "BSc Business Administration", location: "Lagos, Nigeria", graduationDate: "2019", gpa: "", honors: "", coursework: [] }],
      skills: ["Business Process Analysis", "KPI Reporting", "Root-Cause Analysis", "Workflow Design", "Excel"],
      skillCategories: { Analysis: ["Business Process Analysis", "KPI Reporting", "Root-Cause Analysis", "Workflow Design"], Tools: ["Excel"] }
    }),
    job: job({
      title: "Business Analyst",
      company: "Canal Digital",
      location: "Amsterdam, Netherlands",
      description: "Individual contributor role mapping business processes, gathering requirements, analyzing KPIs, identifying root causes, and recommending workflow improvements."
    }),
    expectation: {
      fit: "adjacent", seniority: "senior", jobFamily: "business-analysis", positioningMode: "transition",
      requiredSummaryTerms: ["process"], requiredAnyGroups: [["KPI", "analysis"], ["21%", "workflow"]],
      forbiddenClaims: ["seeking a management role", "Business Analysis Manager"], inferencePolicy: "none", pageTarget: "one"
    }
  },
  {
    id: "synthetic-retail-stretch-10",
    label: "Thin profile with weak fit",
    profile: profile({
      id: "profile-retail",
      contact: { name: "Chloe Martin", email: "chloe.martin@example.com", phone: "", location: "Lyon, France", linkedIn: "" },
      targetRole: "Project Coordinator",
      summary: "Retail associate experienced in shift coordination, customer service, and stock routines.",
      experiences: [{
        id: "retail-role",
        company: "Maison Rue",
        role: "Retail Associate",
        startDate: "Oct 2024",
        endDate: "Present",
        bullets: [
          "Coordinated daily opening and closing checklists across rotating shifts.",
          "Handled 35-50 customer requests per shift.",
          "Updated stock counts and escalated inventory discrepancies.",
          "Scheduled product-display changes with three store colleagues."
        ]
      }],
      education: [{ id: "retail-edu", school: "Université Lumière Lyon 2", degree: "BA Languages", location: "Lyon, France", graduationDate: "2024", gpa: "", honors: "", coursework: [] }],
      skills: ["Checklist Coordination", "Scheduling", "Inventory Counts", "Customer Service"],
      skillCategories: { Operations: ["Checklist Coordination", "Scheduling", "Inventory Counts"], Customer: ["Customer Service"] }
    }),
    job: job({
      title: "Project Coordinator",
      company: "Civic Works",
      location: "Lyon, France",
      description: "Coordinate project schedules, maintain action logs, prepare status updates, track risks, and support project meetings. Jira and formal project experience are preferred."
    }),
    expectation: {
      fit: "stretch", seniority: "junior", jobFamily: "project-management", positioningMode: "transferable",
      requiredSummaryTerms: ["coordinat"], requiredAnyGroups: [["schedule", "checklist"]],
      forbiddenClaims: ["Project Coordinator with", "Jira", "project risk management"], inferencePolicy: "none", pageTarget: "one"
    }
  },
  {
    id: "synthetic-authorization-11",
    label: "Work authorization differentiator",
    profile: profile({
      id: "profile-authorization",
      contact: { name: "Leila Haddad", email: "leila.haddad@example.com", phone: "", location: "Kraków, Poland", linkedIn: "" },
      targetRole: "Financial Analyst",
      summary: "Financial analyst experienced in reporting, variance analysis, and reconciliations. Legally authorized to work in Poland without sponsorship.",
      experiences: [{
        id: "authorization-role",
        company: "Baltic Energy Services",
        role: "Finance Analyst",
        startDate: "Jan 2023",
        endDate: "Present",
        bullets: [
          "Prepared monthly management reporting and variance commentary.",
          "Reconciled balance-sheet accounts and investigated exceptions.",
          "Built rolling expense forecasts in Excel.",
          "Supported annual budgeting with department stakeholders."
        ]
      }],
      education: [{ id: "authorization-edu", school: "Warsaw School of Economics", degree: "MSc Finance", location: "Warsaw, Poland", graduationDate: "2022", gpa: "", honors: "", coursework: [] }],
      skills: ["Management Reporting", "Variance Analysis", "Account Reconciliation", "Forecasting", "Excel"],
      skillCategories: { Finance: ["Management Reporting", "Variance Analysis", "Account Reconciliation", "Forecasting"], Tools: ["Excel"] },
      rawText: "Legally authorized to work in Poland without sponsorship."
    }),
    job: job({
      title: "Financial Analyst",
      company: "Kraków Manufacturing Group",
      location: "Kraków, Poland",
      description: "Prepare forecasts, variance analysis, reconciliations, and management reporting. Applicants must already have unrestricted authorization to work in Poland; sponsorship is not available."
    }),
    expectation: {
      fit: "direct", seniority: "mid", jobFamily: "finance", positioningMode: "target-identity",
      requiredSummaryTerms: ["Poland", "without sponsorship"], requiredAnyGroups: [["forecast", "variance"]],
      forbiddenClaims: ["Polish citizen"], inferencePolicy: "none", pageTarget: "one"
    }
  },
  {
    id: "synthetic-optimal-summary-12",
    label: "Already-optimal summary",
    profile: profile({
      id: "profile-security",
      contact: { name: "Marcus Reed", email: "marcus.reed@example.com", phone: "", location: "Austin, TX", linkedIn: "" },
      targetRole: "Security Operations Analyst",
      summary: "Security Operations Analyst with 4 years monitoring SIEM alerts, investigating endpoint incidents, and improving incident-response playbooks. Reduced false-positive escalations by 28% through detection-rule tuning and provides audit-ready documentation across cloud and endpoint investigations for cross-functional security teams.",
      experiences: [{
        id: "security-role",
        company: "IronPeak Software",
        role: "Security Operations Analyst",
        startDate: "Jun 2022",
        endDate: "Present",
        bullets: [
          "Monitored SIEM alerts and investigated endpoint incidents across cloud and corporate environments.",
          "Reduced false-positive escalations by 28% through detection-rule tuning.",
          "Maintained incident-response playbooks and audit-ready case documentation.",
          "Coordinated containment actions with infrastructure and identity teams."
        ]
      }],
      education: [{ id: "security-edu", school: "Texas State University", degree: "BSc Information Systems", location: "San Marcos, TX", graduationDate: "2022", gpa: "", honors: "", coursework: [] }],
      skills: ["SIEM Monitoring", "Incident Response", "Endpoint Security", "Detection Engineering", "Case Documentation"],
      skillCategories: { Security: ["SIEM Monitoring", "Incident Response", "Endpoint Security", "Detection Engineering", "Case Documentation"] }
    }),
    job: job({
      title: "Security Operations Analyst",
      company: "Lone Star Networks",
      location: "Austin, TX",
      description: "Monitor SIEM alerts, investigate endpoint and cloud incidents, maintain incident-response playbooks, tune detection rules, and document security cases for audit."
    }),
    expectation: {
      fit: "direct", seniority: "mid", jobFamily: "cybersecurity", positioningMode: "target-identity",
      requiredSummaryTerms: ["SIEM", "incident"], requiredAnyGroups: [["28%", "detection"]],
      forbiddenClaims: ["managed a SOC", "CISSP"], inferencePolicy: "none", pageTarget: "one"
    }
  }
];
