/**
 * UI initialization and utility functions
 */

document.addEventListener('DOMContentLoaded', function() {
  // Initialize Bootstrap tooltips
  const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
  tooltipTriggerList.map(function (tooltipTriggerEl) {
    return new bootstrap.Tooltip(tooltipTriggerEl);
  });

  // Add responsive behavior for mobile devices
  if (window.innerWidth < 768) {
    setupMobileResponsiveness();
  }

  // Enable popovers if needed
  const popoverTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="popover"]'));
  popoverTriggerList.map(function (popoverTriggerEl) {
    return new bootstrap.Popover(popoverTriggerEl);
  });

  // Setup autosaving for settings
  setupAutoSave();
  
  // Display last saved time if available
  displayLastSavedTime();
});

/**
 * Sets up autosaving for settings
 */
function setupAutoSave() {
  // API Key autosave
  const apiKeyInput = document.getElementById('apiKeyInput');
  if (apiKeyInput) {
    apiKeyInput.addEventListener('input', function() {
      validateApiKey(this);
    });
    apiKeyInput.addEventListener('blur', function() {
      saveSettingsToLocalStorage();
      showSavedIndicator(this);
    });
  }

  // Base URL autosave
  const baseUrlInput = document.getElementById('baseUrlInput');
  if (baseUrlInput) {
    baseUrlInput.addEventListener('input', function() {
      validateBaseUrl(this);
    });
    baseUrlInput.addEventListener('blur', function() {
      saveSettingsToLocalStorage();
      showSavedIndicator(this);
    });
  }
  
  // Model selection autosave
  const modelSelect = document.getElementById('modelSelect');
  if (modelSelect) {
    modelSelect.addEventListener('change', function() {
      saveSettingsToLocalStorage();
      showSavedIndicator(this);
    });
  }

  // Create save indicator element if it doesn't exist
  if (!document.getElementById('saveIndicator')) {
    const saveIndicator = document.createElement('div');
    saveIndicator.id = 'saveIndicator';
    saveIndicator.className = 'save-indicator';
    saveIndicator.textContent = 'Settings saved';
    document.body.appendChild(saveIndicator);
  }
}

/**
 * Automatically save settings to localStorage
 */
function saveSettingsToLocalStorage() {
  const apiKeyInput = document.getElementById('apiKeyInput');
  const baseUrlInput = document.getElementById('baseUrlInput');
  const modelSelect = document.getElementById('modelSelect');
  
  if (!apiKeyInput || !baseUrlInput || !modelSelect) return;
  
  const apiKey = apiKeyInput.value.trim();
  const baseUrl = baseUrlInput.value.trim() || 'https://api.openai.com/v1';
  const model = modelSelect.value;
  
  const isCustomBaseUrl = baseUrl !== 'https://api.openai.com/v1';
  
  const settings = {
    apiKey: apiKey,
    baseUrl: baseUrl,
    model: model,
    isCustomBaseUrl: isCustomBaseUrl,
    lastSaved: new Date().toISOString()
  };
  
  localStorage.setItem('dialogueSettings', JSON.stringify(settings));
  
  // Update UI indicator for custom URL
  updateCustomUrlIndicator(isCustomBaseUrl);
  
  // Reinitialize clients with new settings
  if (window.initializeClients) {
    window.initializeClients();
  }
  
  console.log('Settings saved at', new Date().toLocaleTimeString());
}

/**
 * Validates an OpenAI API key
 * @param {HTMLInputElement} input - The input element
 * @returns {boolean} - Whether the API key is valid
 */
function validateApiKey(input) {
  const value = input.value.trim();
  const isValid = value.startsWith('sk-') && value.length >= 20;
  
  // Remove validation visuals
  input.classList.remove('is-valid', 'is-invalid');
  
  return isValid;
}

/**
 * Updates the UI indicator for custom URL usage
 * @param {boolean} isCustom - Whether a custom URL is being used
 */
function updateCustomUrlIndicator(isCustom) {
  const indicator = document.getElementById('settingsIndicator');
  if (indicator) {
    // Always just show "Settings" without a badge
    indicator.innerHTML = 'Settings';
  }
}

/**
 * Validates a URL
 * @param {HTMLInputElement} input - The input element
 * @returns {boolean} - Whether the URL is valid
 */
function validateBaseUrl(input) {
  const value = input.value.trim();
  let isValid = false;
  
  try {
    if (value.length > 0) {
      const url = new URL(value);
      isValid = url.protocol === 'http:' || url.protocol === 'https:';
    }
  } catch (e) {
    isValid = false;
  }
  
  // Remove validation visuals
  input.classList.remove('is-valid', 'is-invalid');
  
  return isValid;
}

/**
 * Sets up responsive behavior for mobile devices
 */
function setupMobileResponsiveness() {
  // Add swipe gestures for settings panel
  const mainContent = document.querySelector('.main-content');
  const rightPanel = document.getElementById('rightPanel');
  
  let touchStartX = 0;
  let touchEndX = 0;
  
  document.addEventListener('touchstart', function(e) {
    touchStartX = e.changedTouches[0].screenX;
  }, false);
  
  document.addEventListener('touchend', function(e) {
    touchEndX = e.changedTouches[0].screenX;
    handleSwipeGesture();
  }, false);
  
  function handleSwipeGesture() {
    const swipeThreshold = 100;
    
    if (touchEndX - touchStartX > swipeThreshold) {
      // Swipe right - close panel
      if (rightPanel.classList.contains('show')) {
        togglePanel();
      }
    } else if (touchStartX - touchEndX > swipeThreshold) {
      // Swipe left - open panel
      if (!rightPanel.classList.contains('show')) {
        togglePanel();
      }
    }
  }
  
  // Adjust message widths for smaller screens
  const messageElements = document.querySelectorAll('.message');
  messageElements.forEach(function(message) {
    message.style.maxWidth = '95%';
  });
}

/**
 * Format a date for display
 * @param {Date} date - The date to format
 * @returns {string} - Formatted date string
 */
function formatDate(date) {
  return date.toLocaleString();
}

/**
 * Creates a customized typing indicator
 * @param {string} text - Optional text to show with the indicator
 * @returns {HTMLElement} - The typing indicator element
 */
function createTypingIndicator(text = '') {
  const indicatorContainer = document.createElement('div');
  indicatorContainer.className = 'typing-indicator';
  
  const dot1 = document.createElement('div');
  const dot2 = document.createElement('div');
  const dot3 = document.createElement('div');
  
  dot1.className = 'typing-dot';
  dot2.className = 'typing-dot';
  dot3.className = 'typing-dot';
  
  indicatorContainer.appendChild(dot1);
  indicatorContainer.appendChild(dot2);
  indicatorContainer.appendChild(dot3);
  
  if (text) {
    const textSpan = document.createElement('span');
    textSpan.textContent = text;
    textSpan.className = 'ms-2';
    indicatorContainer.appendChild(textSpan);
  }
  
  return indicatorContainer;
}

/**
 * Toggle dark mode
 */
function toggleDarkMode() {
  document.body.classList.toggle('dark-mode');
  const isDarkMode = document.body.classList.contains('dark-mode');
  localStorage.setItem('darkMode', isDarkMode);
  
  // Update the icon
  const darkModeToggle = document.getElementById('darkModeToggle');
  if (darkModeToggle) {
    if (isDarkMode) {
      darkModeToggle.innerHTML = '<i class="bi bi-sun"></i>';
      darkModeToggle.title = 'Switch to Light Mode';
    } else {
      darkModeToggle.innerHTML = '<i class="bi bi-moon-stars"></i>';
      darkModeToggle.title = 'Switch to Dark Mode';
    }
  }
}

/**
 * Checks if dark mode should be enabled based on user preference
 */
function checkDarkMode() {
  const isDarkMode = localStorage.getItem('darkMode') === 'true' || 
      (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  
  if (isDarkMode) {
    document.body.classList.add('dark-mode');
    
    // Update the icon
    const darkModeToggle = document.getElementById('darkModeToggle');
    if (darkModeToggle) {
      darkModeToggle.innerHTML = '<i class="bi bi-sun"></i>';
      darkModeToggle.title = 'Switch to Light Mode';
    }
  }
}

// Initialize dark mode check
checkDarkMode();

/**
 * Show a visual indicator that settings have been saved
 * @param {HTMLElement} element - The input element that triggered the save
 */
function showSavedIndicator(element) {
  // Add a brief highlight to the element
  element.classList.add('saved');
  setTimeout(() => {
    element.classList.remove('saved');
  }, 1000);
  
  // Show floating save indicator
  const saveIndicator = document.getElementById('saveIndicator');
  if (saveIndicator) {
    saveIndicator.classList.add('show');
    setTimeout(() => {
      saveIndicator.classList.remove('show');
    }, 2000);
  }
}

/**
 * Display the last time settings were saved
 */
function displayLastSavedTime() {
  const settings = JSON.parse(localStorage.getItem('dialogueSettings') || '{}');
  if (settings.lastSaved) {
    const lastSaved = new Date(settings.lastSaved);
    const timeString = lastSaved.toLocaleTimeString();
    
    // Create a small indicator in the settings panel
    const panel = document.querySelector('.panel-content');
    if (panel) {
      const savedInfo = document.createElement('div');
      savedInfo.className = 'text-muted small mt-2 text-end';
      savedInfo.innerHTML = `Last saved: ${timeString}`;
      panel.appendChild(savedInfo);
    }
  }
}