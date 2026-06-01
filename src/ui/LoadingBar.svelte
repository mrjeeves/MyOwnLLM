<script lang="ts">
  // Indeterminate activity bar: a segment that slides across a track to
  // signal "still moving, not frozen" on load screens where there's no
  // real percentage to report (hardware detection, the startup model
  // warm). Pure presentation — shared by the initial splash and the
  // warming overlay's LoadingPulse so both read the same.
</script>

<div class="loading-bar" role="progressbar" aria-label="Loading">
  <span class="loading-bar-fill"></span>
</div>

<style>
  .loading-bar {
    align-self: center;
    position: relative;
    width: 150px;
    max-width: 100%;
    height: 3px;
    border-radius: 2px;
    background: #242430;
    overflow: hidden;
  }
  .loading-bar-fill {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    width: 40%;
    border-radius: 2px;
    background: linear-gradient(90deg, transparent, #6e6ef7 50%, transparent);
    animation: loading-bar-slide 1.3s ease-in-out infinite;
  }
  @keyframes loading-bar-slide {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(250%); }
  }
</style>
