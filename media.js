/* Pin Sheet: turns Pinterest pin data into downloadable files.
   Shared by the content script and the tests. No DOM, no chrome.* calls. */
(function (root) {
  'use strict';

  const SIZE_SEG = /\/(\d+x\d*|originals|orig)\//i;

  function uniq(list) {
    return [...new Set(list.filter(Boolean))];
  }

  function extOf(url) {
    const m = String(url || '').split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : '';
  }

  function largest(images) {
    let best = null;
    for (const v of Object.values(images || {})) {
      if (v && v.url && (!best || (v.width || 0) > (best.width || 0))) best = v;
    }
    return best;
  }

  // From any sized pinimg URL, guess the "originals" URL. The extension can differ, so try a few.
  function originalGuesses(url) {
    const clean = String(url || '').split(/[?#]/)[0];
    if (!/pinimg\.com/i.test(clean) || !SIZE_SEG.test(clean)) return [];
    const orig = clean.replace(SIZE_SEG, '/originals/');
    const stem = orig.replace(/\.[a-z0-9]+$/i, '');
    return uniq([orig, stem + '.png', stem + '.jpg', stem + '.gif', stem + '.webp']);
  }

  function kindForUrl(url) {
    return extOf(url) === 'gif' ? 'gif' : 'image';
  }

  // Best version of an image. URLs that came from the API are trusted; guesses get verified.
  function imageFile(images) {
    if (!images) return null;
    const exact = images.orig || images.originals;
    if (exact && exact.url) return { kind: kindForUrl(exact.url), urls: [exact.url], verify: false };
    const big = largest(images);
    if (!big) return null;
    return { kind: kindForUrl(big.url), urls: uniq(originalGuesses(big.url).concat(big.url)), verify: true };
  }

  // For a right-clicked image with no pin data behind it.
  function imageFromUrl(url) {
    return { kind: kindForUrl(url), urls: uniq(originalGuesses(url).concat(url)), verify: true };
  }

  // Videos: prefer real MP4 files (they carry audio). HLS streams are the fallback.
  function videoFile(videoList) {
    const entries = Object.values(videoList || {}).filter((v) => v && v.url);
    if (!entries.length) return null;
    const mp4 = entries
      .filter((v) => extOf(v.url) === 'mp4')
      .sort((a, b) => (b.width || 0) - (a.width || 0))
      .map((v) => v.url);
    const hls = entries.filter((v) => extOf(v.url) === 'm3u8').map((v) => v.url);
    const derived = [];
    for (const u of hls) {
      const clean = u.split(/[?#]/)[0];
      let m = clean.match(/^(https?:\/\/[^/]+\/videos\/iht)\/hls\/(.+)\.m3u8$/i);
      if (m) derived.push(`${m[1]}/expMp4/${m[2]}_720w.mp4`);
      m = clean.match(/^(https?:\/\/[^/]+\/videos\/mc)\/hls\/(.+)\.m3u8$/i);
      if (m) derived.push(`${m[1]}/720p/${m[2]}.mp4`);
    }
    const urls = uniq(mp4.concat(derived));
    if (!urls.length && !hls.length) return null;
    return { kind: 'video', urls, hls: uniq(hls), verify: true };
  }

  function mediaFrom(holder) {
    if (!holder) return null;
    if (holder.video && holder.video.video_list) {
      const v = videoFile(holder.video.video_list);
      if (v) return v;
    }
    if (holder.image && holder.image.images) return imageFile(holder.image.images);
    return null;
  }

  // Idea pins: one file per page (a page can hold several media blocks).
  function storyFiles(sp) {
    const files = [];
    for (const page of (sp && sp.pages) || []) {
      const before = files.length;
      for (const block of (page && page.blocks) || []) {
        const f = mediaFrom(block);
        if (f) files.push(f);
      }
      if (files.length === before) {
        const f = mediaFrom(page);
        if (f) files.push(f);
      }
    }
    return files;
  }

  function carouselFiles(cd) {
    return ((cd && cd.carousel_slots) || []).map((s) => imageFile(s && s.images)).filter(Boolean);
  }

  // Every file a pin should produce, in order.
  function pinFiles(pin) {
    if (!pin) return [];
    let files = storyFiles(pin.story_pin_data);
    if (!files.length && pin.videos && pin.videos.video_list) {
      const v = videoFile(pin.videos.video_list);
      if (v) files = [v];
    }
    if (!files.length) files = carouselFiles(pin.carousel_data);
    if (!files.length && pin.embed && pin.embed.type === 'gif' && pin.embed.src) {
      files = [{ kind: 'gif', urls: [pin.embed.src], verify: false }];
    }
    if (!files.length) {
      const img = imageFile(pin.images);
      if (img) files = [img];
    }
    return files;
  }

  // Board feeds sometimes carry only the cover page of an idea pin.
  function needsDetail(pin) {
    if (!pin) return false;
    const sp = pin.story_pin_data;
    if (pin.story_pin_data_id && !sp) return true;
    if (sp && sp.page_count && (!sp.pages || sp.pages.length < sp.page_count)) return true;
    return false;
  }

  function titleOf(pin) {
    const t = [pin && pin.title, pin && pin.grid_title, pin && pin.description]
      .map((s) => String(s || '').trim())
      .find(Boolean);
    return t || '';
  }

  function thumbOf(pin) {
    const im = (pin && pin.images) || {};
    const pick = im['474x'] || im['236x'] || im['736x'] || im.orig || largest(im);
    return pick ? pick.url : '';
  }

  // What the picker shows on each frame.
  function describe(pin) {
    const sp = pin.story_pin_data;
    const pages = sp ? sp.page_count || ((sp.pages || []).length) : 0;
    const slots = ((pin.carousel_data && pin.carousel_data.carousel_slots) || []).length;
    const storyVideo = !!(sp && (sp.pages || []).some((p) => p && (p.video || (p.blocks || []).some((b) => b && b.video))));
    const orig = pin.images && (pin.images.orig || pin.images.originals);
    let motion = null;
    if ((pin.videos && pin.videos.video_list) || storyVideo) motion = 'video';
    else if ((pin.embed && pin.embed.type === 'gif') || (orig && extOf(orig.url) === 'gif')) motion = 'gif';
    let label = motion === 'video' ? 'Video' : motion === 'gif' ? 'GIF' : 'Image';
    if (pages > 1) label = `${pages} pages`;
    else if (slots > 1) label = `${slots} images`;
    else if (!sp && pin.story_pin_data_id && !motion) label = 'Idea pin';
    return { motion, label, title: titleOf(pin), thumb: thumbOf(pin) };
  }

  // Safe single path segment for chrome.downloads.
  function cleanPart(s, max) {
    max = max || 80;
    let out = String(s || '')
      .normalize('NFKC')
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*​-‏‪-‮⁦-⁩]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s~]+/, '')
      .replace(/[.\s]+$/, '');
    if (out.length > max) out = out.slice(0, max).replace(/[.\s]+$/, '').trim();
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(out)) out = '_' + out;
    return out;
  }

  function fileBase(pin, naming) {
    const id = String(pin.id);
    if (naming === 'id') return id;
    const t = cleanPart(titleOf(pin), 60);
    return t ? `${t}_${id}` : id;
  }

  function pinIdFromUrl(url) {
    const m = String(url || '').match(/\/pin\/(?:[^/?#]*--)?(\d{5,})/);
    return m ? m[1] : null;
  }

  const api = {
    extOf, originalGuesses, imageFile, imageFromUrl, videoFile, pinFiles, needsDetail,
    describe, titleOf, thumbOf, cleanPart, fileBase, pinIdFromUrl,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PinMedia = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
