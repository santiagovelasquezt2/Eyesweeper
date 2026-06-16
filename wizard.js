// wizard.js — guided onboarding overlay. Walks a first-time user through:
//   1) welcome  2) glasses?  3) camera  4) gaze calibration  5) blink/wink test  6) done
// Keeps the UX gentle: every step explains what's about to happen and why.

export function runWizard(ctx) {
  const wizard = document.getElementById("wizard");
  const stepsEl = document.getElementById("wizard-steps");
  const bodyEl = document.getElementById("wizard-body");
  const backBtn = document.getElementById("wizard-back");
  const nextBtn = document.getElementById("wizard-next");
  const closeBtn = document.getElementById("wizard-close");

  let i = 0;
  let blinkCount = 0;
  let blinkUnsub = null;

  const steps = [
    {
      title: "Welcome to EyeSweeper 👁️",
      render: () => `
        <p>Let's set up hands-free play in about a minute. You'll:</p>
        <ol class="wiz-list">
          <li>Turn on your camera (stays on your device)</li>
          <li>Calibrate where you're looking</li>
          <li>Test your flag gesture</li>
        </ol>
        <p class="hint">You can stop any time — mouse and keyboard always work too.</p>`,
      next: "Start",
    },
    {
      title: "Do you wear glasses?",
      render: () => `
        <p>Glasses and strong glare can confuse fixed thresholds. <b>Glasses mode</b>
        uses your eyelids' <i>relative</i> motion instead, which is far more reliable.</p>
        <label class="wiz-big-toggle">
          <input type="checkbox" id="wiz-glasses" ${ctx.settings.glasses ? "checked" : ""}/>
          <span>👓 I wear glasses / there's glare — use Glasses mode</span>
        </label>
        <label class="wiz-big-toggle">
          <span>Flag gesture</span>
          <select id="wiz-flag">
            <option value="blink" ${ctx.settings.flagGesture === "blink" ? "selected" : ""}>Blink (both eyes)</option>
            <option value="wink" ${ctx.settings.flagGesture === "wink" ? "selected" : ""}>Wink (one eye)</option>
          </select>
        </label>
        <p class="hint">Tip: if blinking is awkward or unreliable for you, try Wink.</p>`,
      onEnter: () => {
        bodyEl.querySelector("#wiz-glasses").addEventListener("change", (e) => {
          ctx.settings.glasses = e.target.checked;
          ctx.tracker.setGlassesMode(e.target.checked);
          if (e.target.checked && ctx.settings.smoothing < 0.35) ctx.settings.smoothing = 0.4;
          ctx.saveSettings(); ctx.applySettings();
        });
        bodyEl.querySelector("#wiz-flag").addEventListener("change", (e) => {
          ctx.settings.flagGesture = e.target.value;
          ctx.tracker.flagGesture = e.target.value;
          ctx.saveSettings(); ctx.applySettings();
        });
      },
      next: "Next",
    },
    {
      title: "Turn on your camera",
      render: () => `
        <p>EyeSweeper needs your webcam to see your eyes. Video is processed
        <b>entirely on your device</b> — nothing is uploaded.</p>
        <p id="wiz-cam-status" class="wiz-status">${ctx.isEyeOn() ? "✅ Camera is on." : "Click below to enable the camera."}</p>
        <button id="wiz-cam-btn" class="primary-btn" ${ctx.isEyeOn() ? "disabled" : ""}>
          ${ctx.isEyeOn() ? "Camera enabled" : "Enable camera"}
        </button>`,
      onEnter: () => {
        const btn = bodyEl.querySelector("#wiz-cam-btn");
        const st = bodyEl.querySelector("#wiz-cam-status");
        nextBtn.disabled = !ctx.isEyeOn();
        btn?.addEventListener("click", async () => {
          btn.textContent = "Starting…"; btn.disabled = true;
          const ok = await ctx.startEye();
          if (ok) { st.textContent = "✅ Camera is on."; btn.textContent = "Camera enabled"; nextBtn.disabled = false; }
          else { st.textContent = "⚠️ Couldn't start the camera. Check permissions."; btn.textContent = "Try again"; btn.disabled = false; }
        });
      },
      next: "Next",
    },
    {
      title: "Calibrate your gaze",
      render: () => `
        <p>Nine dots will appear. <b>Look straight at each dot</b> and keep your head
        still until it fills. Takes about ten seconds.</p>
        <p id="wiz-cal-status" class="wiz-status">${ctx.tracker.hasCalibration() ? "✅ Already calibrated — recalibrate if you like." : "Ready when you are."}</p>
        <button id="wiz-cal-btn" class="primary-btn">${ctx.tracker.hasCalibration() ? "Recalibrate" : "Start calibration"}</button>`,
      onEnter: () => {
        const btn = bodyEl.querySelector("#wiz-cal-btn");
        const st = bodyEl.querySelector("#wiz-cal-status");
        nextBtn.disabled = !ctx.tracker.hasCalibration();
        btn?.addEventListener("click", async () => {
          wizard.classList.add("dimmed");
          const ok = await ctx.runCalibration();
          wizard.classList.remove("dimmed");
          st.textContent = ok ? "✅ Calibrated!" : "⚠️ That didn't take — try again with good lighting.";
          btn.textContent = "Recalibrate";
          nextBtn.disabled = !ok;
        });
      },
      next: "Next",
    },
    {
      title: "Test your flag gesture",
      render: () => `
        <p>Do your flag gesture (<b>${ctx.settings.flagGesture === "wink" ? "wink one eye" : "blink both eyes"}</b>,
        deliberately, slightly longer than normal) <b>twice</b>.</p>
        <div class="wiz-blinks"><span id="wiz-b1" class="wiz-dot">1</span><span id="wiz-b2" class="wiz-dot">2</span></div>
        <p id="wiz-blink-status" class="wiz-status">Watch the “Eye openness” bar move as you close your eyes.</p>
        <p class="hint">Not registering? Lower “Blink sensitivity” later, or switch gesture. Natural quick blinks are ignored on purpose.</p>`,
      onEnter: () => {
        blinkCount = 0;
        const st = bodyEl.querySelector("#wiz-blink-status");
        nextBtn.disabled = true;
        const prev = ctx.tracker.cb.onFlag;
        blinkUnsub = () => { ctx.tracker.cb.onFlag = prev; };
        ctx.tracker.cb.onFlag = (kind) => {
          prev?.(kind);
          blinkCount++;
          const dot = bodyEl.querySelector(`#wiz-b${Math.min(blinkCount, 2)}`);
          if (dot) dot.classList.add("done");
          ctx.sfx.flag(true);
          if (blinkCount >= 2) { st.textContent = "✅ Great — gesture detected!"; nextBtn.disabled = false; }
          else st.textContent = "Detected 1 — one more.";
        };
      },
      onLeave: () => { if (blinkUnsub) { blinkUnsub(); blinkUnsub = null; } },
      next: "Next",
    },
    {
      title: "You're all set 🎉",
      render: () => `
        <p><b>Aim</b> with your gaze · <b>dwell</b> to reveal · <b>${ctx.settings.flagGesture === "wink" ? "wink" : "blink"}</b> to flag.</p>
        <p>Tweak dwell time, sensitivity, and smoothing any time in the side panel.
        Re-run this wizard from <b>Setup wizard</b>.</p>
        <p class="hint">Have fun — and remember mouse/keyboard always work as backup.</p>`,
      next: "Finish",
    },
  ];

  function renderSteps() {
    stepsEl.innerHTML = steps.map((_, idx) =>
      `<span class="wiz-step ${idx === i ? "active" : idx < i ? "done" : ""}"></span>`).join("");
  }

  function show() {
    const step = steps[i];
    renderSteps();
    bodyEl.innerHTML = `<h3>${step.title}</h3>${step.render()}`;
    backBtn.style.visibility = i === 0 ? "hidden" : "visible";
    nextBtn.textContent = step.next || "Next";
    nextBtn.disabled = false;
    step.onEnter?.();
  }

  function leave() { steps[i].onLeave?.(); }

  function close() {
    leave();
    wizard.classList.add("hidden");
    wizard.classList.remove("dimmed");
  }

  nextBtn.onclick = () => {
    leave();
    if (i < steps.length - 1) { i++; show(); }
    else { close(); ctx.onDone?.(); }
  };
  backBtn.onclick = () => { leave(); if (i > 0) { i--; show(); } };
  closeBtn.onclick = () => close();

  wizard.classList.remove("hidden");
  i = 0;
  show();
}
