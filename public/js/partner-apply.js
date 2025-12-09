document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('partner-application-form');
  const messageEl = document.getElementById('form-message');
  const termsCheckbox = document.getElementById('terms');
  const submitBtn = document.getElementById('submit-btn');

  if (termsCheckbox && submitBtn) {
    submitBtn.disabled = !termsCheckbox.checked;

    termsCheckbox.addEventListener('change', () => {
      submitBtn.disabled = !termsCheckbox.checked;
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    messageEl.textContent = '';
    messageEl.className = 'form-message';

    const termsAccepted = termsCheckbox ? termsCheckbox.checked : false;
    if (!termsAccepted) {
      messageEl.textContent = 'You must agree to the partnership terms to apply.';
      messageEl.classList.add('error');
      return;
    }

    const payload = {
      name: document.getElementById('name').value.trim(),
      email: document.getElementById('email').value.trim(),
      whatsapp: document.getElementById('whatsapp').value.trim(),
      country: document.getElementById('country').value.trim(),
      audience: document.getElementById('audience').value.trim(),
      platform: document.getElementById('platform').value.trim(),
      motivation: document.getElementById('motivation').value.trim(),
      termsAccepted: true
    };

    try {
      const response = await fetch('/api/partner-application', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Something went wrong. Please try again.');
      }

      messageEl.textContent = data.message || 'Application submitted successfully.';
      messageEl.classList.add('success');
      form.reset();
    } catch (err) {
      console.error('Application error:', err);
      messageEl.textContent = err.message || 'Error submitting application.';
      messageEl.classList.add('error');
    }
  });
});
