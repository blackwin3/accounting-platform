const express = require("express");
const router = express.Router();
const { prisma } = require("../../services/postingEngine");

// GET /knowledge
router.get("/knowledge", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const rows = await prisma.Knowledge.findMany({ where: { Entreprise_id: entrepriseId }, orderBy: { Knowledge_id: "desc" } });
    const authorIds = rows.map((k) => k.Author).filter(Boolean);
    const authors = await prisma.Stakeholder.findMany({ where: { Stakeholder_id: { in: authorIds } } });
    const authorById = Object.fromEntries(authors.map((s) => [s.Stakeholder_id, s]));

    res.render("knowledge", {
      title: "Knowledge",
      active: "knowledge",
      entries: rows.map((k) => ({
        type: k.Knowledge_type,
        context: k.Context,
        explanation: k.Explanation,
        decisionReason: k.Decision_Reason,
        recommendation: k.Recommendation,
        lessonLearned: k.Lesson_Learned,
        author: k.Author && authorById[k.Author] ? [authorById[k.Author].First_name, authorById[k.Author].Last_name].filter(Boolean).join(" ") : "Unknown",
        date: k.Entry_date ? new Date(k.Entry_date).toLocaleDateString("en-GB") : "",
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading knowledge: " + err.message);
  }
});

// GET /narrative
router.get("/narrative", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const rows = await prisma.Narrative.findMany({ where: { Entreprise_id: entrepriseId }, orderBy: { Narrative_id: "desc" }, take: 100 });

    // Look up receipts for narratives that have a Records_id
    const recordsIds = rows.map(n => n.Records_id).filter(Boolean);
    let receiptsByRecordsId = {};
    if (recordsIds.length > 0) {
      const docs = await prisma.Documents.findMany({
        where: { Records_id: { in: recordsIds }, Document_type: "RECEIPT", Entreprise_id: entrepriseId },
      });
      docs.forEach(d => { receiptsByRecordsId[d.Records_id] = d.Documents_no; });
    }

    res.render("narrative", {
      title: "Narrative",
      active: "narrative",
      entries: rows.map((n) => ({
        date: n.Narrative_date ? new Date(n.Narrative_date).toLocaleString("en-GB") : "",
        source: n.Narrative_source || (n.Is_Generated ? "SYSTEM" : "HUMAN"),
        isGenerated: !!n.Is_Generated,
        description: n.Description,
        transactionId: n.Transaction_id || null,
        recordsId: n.Records_id || null,
        receiptNo: n.Records_id ? (receiptsByRecordsId[n.Records_id] || null) : null,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading narrative: " + err.message);
  }
});

module.exports = router;
