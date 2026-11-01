# Question Bot - what changed

Copy the `t4/` folder over your project (same paths). No new npm packages needed (`jszip` is already in package.json).

NEW
- app/admin/question-bot/page.js + questionBot.module.css   -> the page, at /admin/question-bot
- app/api/admin/question-bot/fetch/route.js                  -> tiny relay (page / image bytes), used by LOCAL mode
- app/api/admin/question-bot/convert/route.js                -> full server-side conversion, used by SERVER mode
- lib/questionBot/miniDom.js, mathConvert.js, parsePage.js   -> shared parser (runs in browser AND server)
- lib/questionBot/safeFetch.js                               -> server-only fetch helper (examside.com / examgoal.net only)

EDITED (one small insertion each)
- components/admin/adminNav.js   -> "Question Bot" sidebar entry (under Exams)
- components/admin/AdminShell.js -> "bot" icon added to ICONS

Both /api/admin/* routes are already protected by proxy.js (admin cookie) - nothing to change there.

Output: JSON in your q_id / q_num / options / section / ques_type / source_id / answer_key / exam_history /
question_html / solution_html shape; images are [href=image1], [href=image2] ... in the JSON and image1.png ... in
the zip (folders: json/ and images/).
