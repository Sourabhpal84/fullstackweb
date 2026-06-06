const loader = document.getElementById("loader");
const cursorGlow = document.getElementById("cursorGlow");
const canvas = document.getElementById("particleCanvas");
const ctx = canvas.getContext("2d");
let particles = [];

function sizeCanvas(){
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}

function createParticles(){
  const count = Math.min(120, Math.floor(window.innerWidth / 12));
  particles = Array.from({ length:count }, () => ({
    x:Math.random() * window.innerWidth,
    y:Math.random() * window.innerHeight,
    vx:(Math.random() - .5) * .35,
    vy:(Math.random() - .5) * .35,
    r:Math.random() * 1.8 + .35,
    a:Math.random() * .7 + .15
  }));
}

function drawParticles(){
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  particles.forEach((p, i) => {
    p.x += p.vx;
    p.y += p.vy;
    if(p.x < 0 || p.x > window.innerWidth) p.vx *= -1;
    if(p.y < 0 || p.y > window.innerHeight) p.vy *= -1;
    ctx.beginPath();
    ctx.fillStyle = `rgba(216,170,79,${p.a})`;
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
    for(let j = i + 1; j < particles.length; j++){
      const q = particles[j];
      const dx = p.x - q.x;
      const dy = p.y - q.y;
      const distance = Math.hypot(dx, dy);
      if(distance < 120){
        ctx.strokeStyle = `rgba(216,170,79,${(1 - distance / 120) * .13})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
      }
    }
  });
  requestAnimationFrame(drawParticles);
}

function initTilt(){
  document.querySelectorAll(".tilt-card").forEach(card => {
    card.addEventListener("mousemove", event => {
      const rect = card.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - .5;
      const y = (event.clientY - rect.top) / rect.height - .5;
      card.style.transform = `rotateY(${x * 9}deg) rotateX(${-y * 9}deg) translateY(-4px)`;
    });
    card.addEventListener("mouseleave", () => {
      card.style.transform = "";
    });
  });
}

function initAnimations(){
  if(window.gsap){
    gsap.registerPlugin(ScrollTrigger);
    gsap.to(".hero-bg-orbit", {
      yPercent:-8,
      scrollTrigger:{ trigger:".hero", start:"top top", end:"bottom top", scrub:true }
    });
    gsap.utils.toArray(".reveal").forEach(element => {
      gsap.to(element, {
        opacity:1,
        y:0,
        duration:1,
        ease:"power3.out",
        scrollTrigger:{ trigger:element, start:"top 84%" }
      });
    });
    gsap.utils.toArray("[data-counter]").forEach(counter => {
      const target = Number(counter.dataset.counter || 0);
      gsap.to(counter, {
        textContent:target,
        duration:1.8,
        snap:{ textContent:1 },
        ease:"power2.out",
        scrollTrigger:{ trigger:counter, start:"top 86%" }
      });
    });
    gsap.to(".skill-cloud span", {
      y:-10,
      stagger:.08,
      repeat:-1,
      yoyo:true,
      duration:1.8,
      ease:"sine.inOut"
    });
  }else{
    document.querySelectorAll(".reveal").forEach(item => {
      item.style.opacity = 1;
      item.style.transform = "none";
    });
  }
}

window.addEventListener("mousemove", event => {
  cursorGlow.style.left = `${event.clientX}px`;
  cursorGlow.style.top = `${event.clientY}px`;
});

window.addEventListener("resize", () => {
  sizeCanvas();
  createParticles();
});

window.addEventListener("load", () => {
  setTimeout(() => loader.classList.add("hide"), 900);
});

sizeCanvas();
createParticles();
drawParticles();
initTilt();
initAnimations();
