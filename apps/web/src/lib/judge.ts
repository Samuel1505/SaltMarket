/** Judge mode is opt-in per page load: `?judge=1`. Players never see judge controls. */
export const JUDGE = (() => {
  try {
    const v = new URLSearchParams(location.search).get('judge');
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
})();
