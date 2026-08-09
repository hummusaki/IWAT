// dashboard.js - Simulates interactivity for the inaccessible dashboard

// Simulate Dashboard Functionality
document.addEventListener('DOMContentLoaded', () => {

    // Add listeners to our very poorly designed action buttons in the table
    const buttons = document.querySelectorAll('.action-buttons .btn');

    buttons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Check which color button it was (since there is no text!)
            if (e.target.classList.contains('btn-primary')) {
                alert('Action initiated (assuming you meant to click the green button).');
            } else if (e.target.classList.contains('btn-danger')) {
                alert('Warning: Destructive action triggered (assuming you meant to click the red button).');
            }
        });
    });

    // Form submission simulation
    const saveBtn = document.querySelector('.settings-panel .btn-primary');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            alert('Settings saved. Hopefully you did not make a mistake, as the text is very small.');
        });
    }
});
