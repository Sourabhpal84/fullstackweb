export type PizzaContent = { slug: string; name: string; category: string; description: string; ingredients: string[]; toppingType: string; prices: { name: string; price: number }[] };

export const pizzas: PizzaContent[] = [
  { slug: "margherita", name: "Margherita Pizza", category: "Classic Pizza", description: "A simple vegetarian pizza with rich tomato sauce, mozzarella and herbs.", ingredients: ["Pizza base", "tomato sauce", "mozzarella", "oregano"], toppingType: "Cheese", prices: [{ name: "Small", price: 99 }, { name: "Medium", price: 199 }, { name: "Large", price: 299 }] },
  { slug: "farmhouse", name: "Farmhouse Pizza", category: "Vegetable Pizza", description: "A colourful vegetarian pizza loaded with onion, capsicum, tomato, corn and cheese.", ingredients: ["Onion", "capsicum", "tomato", "sweet corn", "mozzarella"], toppingType: "Vegetable", prices: [{ name: "Small", price: 149 }, { name: "Medium", price: 249 }, { name: "Large", price: 349 }] },
  { slug: "peppy-paneer", name: "Peppy Paneer Pizza", category: "Paneer Pizza", description: "A bold paneer pizza with capsicum, spiced paneer and melted cheese.", ingredients: ["Paneer", "capsicum", "tomato sauce", "mozzarella", "Indian spices"], toppingType: "Paneer", prices: [{ name: "Small", price: 169 }, { name: "Medium", price: 269 }, { name: "Large", price: 379 }] },
  { slug: "paneer-makhani", name: "Paneer Makhani Pizza", category: "Indian Flavour Pizza", description: "Creamy makhani sauce, seasoned paneer and cheese on a fresh vegetarian pizza base.", ingredients: ["Paneer", "makhani sauce", "onion", "mozzarella", "herbs"], toppingType: "Paneer", prices: [{ name: "Small", price: 179 }, { name: "Medium", price: 289 }, { name: "Large", price: 399 }] }
];

export const deliveryAreas = [
  { slug: "greater-noida", name: "Greater Noida", eta: "30–45 minutes" }, { slug: "alpha-1", name: "Alpha 1", eta: "25–40 minutes" },
  { slug: "beta-1", name: "Beta 1", eta: "25–40 minutes" }, { slug: "knowledge-park", name: "Knowledge Park", eta: "30–45 minutes" },
  { slug: "tugalpur", name: "Tugalpur", eta: "30–45 minutes" }
];

export const commonFaqs = [
  { question: "Does MAGNEETOZ deliver pizza in Greater Noida?", answer: "Yes. MAGNEETOZ delivers vegetarian pizza in supported Greater Noida areas. Availability and the delivery estimate are confirmed from your location at checkout." },
  { question: "What is the usual delivery time?", answer: "The typical estimate is 25–45 minutes, depending on your address, traffic, kitchen load and rider availability." },
  { question: "Are all MAGNEETOZ pizzas vegetarian?", answer: "The pizzas described on these pages are vegetarian. Check the live menu for current availability and item details." },
  { question: "Is online payment available?", answer: "Yes. Secure online payment through Razorpay and Cash on Delivery are available where shown during checkout." }
];
export const checkoutFaqs = [...commonFaqs, { question: "What if payment succeeds but my order is not created?", answer: "Keep the Razorpay payment reference and contact MAGNEETOZ support. The team can verify the payment and help confirm the order or start the applicable refund process." }];
