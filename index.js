require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// الاتصال بقاعدة بيانات Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.get('/', (req, res) => {
  res.send('Hello Maraya! السيرفر شغال 🎉');
});

// API يجيب المنيو (categories + products) فعليًا من قاعدة البيانات
app.get('/api/menu', async (req, res) => {
  const { data: categories, error: catError } = await supabase
    .from('categories')
    .select('*')
    .order('display_order');

  const { data: products, error: prodError } = await supabase
    .from('products')
    .select('*')
    .eq('is_available', true);

  if (catError || prodError) {
    return res.status(500).json({ error: catError?.message || prodError?.message });
  }

  res.json({ categories, products });
});

function isRiyadhWeekend() {
  const riyadhNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Riyadh' }));
  const day = riyadhNow.getDay(); // 0=Sun ... 4=Thu, 5=Fri, 6=Sat
  return [4, 5, 6].includes(day);
}

// إنشاء طلب جديد
app.post('/api/orders', async (req, res) => {
  const { customer_name, customer_phone, table_number, items, offer_pair_ids } = req.body;

  if (!customer_phone || !items || items.length === 0) {
    return res.status(400).json({ error: 'بيانات الطلب ناقصة' });
  }

  try {
    let { data: customer } = await supabase
      .from('customers')
      .select('*')
      .eq('phone', customer_phone)
      .maybeSingle();

    if (!customer) {
      const { data: newCustomer, error: createError } = await supabase
        .from('customers')
        .insert({ phone: customer_phone, name: customer_name })
        .select()
        .single();
      if (createError) throw createError;
      customer = newCustomer;
    }

    let table_id = null;
    if (table_number) {
      const { data: table } = await supabase
        .from('tables')
        .select('id')
        .eq('table_number', table_number)
        .maybeSingle();
      if (table) table_id = table.id;
    }

    const productIds = items.map((i) => i.product_id);
    const { data: products, error: productsError } = await supabase
      .from('products')
      .select('id, base_price')
      .in('id', productIds);
    if (productsError) throw productsError;

    const priceMap = Object.fromEntries(products.map((p) => [p.id, Number(p.base_price)]));
    let total_price = items.reduce(
      (sum, item) => sum + (priceMap[item.product_id] || 0) * item.quantity,
      0
    );

    let notes = null;

    // تطبيق عرض "اشتري مشروب واحصل على الآخر بسعر الأرخص مجانًا" - عطلة نهاية الأسبوع فقط
    if (
      Array.isArray(offer_pair_ids) &&
      offer_pair_ids.length === 2 &&
      offer_pair_ids[0] !== offer_pair_ids[1] &&
      isRiyadhWeekend()
    ) {
      const [idA, idB] = offer_pair_ids;
      const hasA = items.some((i) => i.product_id === idA);
      const hasB = items.some((i) => i.product_id === idB);
      if (hasA && hasB) {
        const priceA = priceMap[idA] || 0;
        const priceB = priceMap[idB] || 0;
        const discount = Math.min(priceA, priceB);
        total_price -= discount;
        notes = 'عرض نهاية الأسبوع: مشروب مجاني (خصم ' + discount + ' ريال)';
      }
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        customer_id: customer.id,
        table_id,
        order_type: table_id ? 'dine_in_qr' : 'counter',
        status: 'pending',
        payment_status: 'unpaid',
        total_price,
        notes,
      })
      .select()
      .single();
    if (orderError) throw orderError;

    const orderItems = items.map((item) => ({
      order_id: order.id,
      product_id: item.product_id,
      quantity: item.quantity,
      unit_price: priceMap[item.product_id] || 0,
    }));

    const { error: itemsError } = await supabase.from('order_items').insert(orderItems);
    if (itemsError) throw itemsError;

    res.json({ success: true, order_id: order.id, total_price });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// إنشاء فاتورة دفع أونلاين لطلب موجود
app.post('/api/orders/:id/create-payment', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: order, error } = await supabase.from('orders').select('*').eq('id', id).single();
    if (error || !order) return res.status(404).json({ error: 'الطلب غير موجود' });

    const amountHalalas = Math.round(Number(order.total_price) * 100);

    const response = await fetch('https://api.moyasar.com/v1/invoices', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(process.env.MOYASAR_SECRET_KEY + ':').toString('base64'),
      },
      body: JSON.stringify({
        amount: amountHalalas,
        currency: 'SAR',
        description: `طلب مراية #${order.id}`,
        success_url: `https://maraya-frontend.vercel.app/payment-result?order_id=${order.id}`,
      }),
    });

    const invoice = await response.json();
    if (!response.ok) throw new Error(invoice.message || 'فشل إنشاء فاتورة الدفع');

    res.json({ url: invoice.url, invoice_id: invoice.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// تأكيد حالة الدفع بعد رجوع العميل من Moyasar
app.post('/api/orders/:id/confirm-payment', async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_id } = req.body;

    const response = await fetch(`https://api.moyasar.com/v1/payments/${payment_id}`, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(process.env.MOYASAR_SECRET_KEY + ':').toString('base64'),
      },
    });
    const payment = await response.json();

    if (payment.status === 'paid') {
      await supabase.from('orders').update({ payment_status: 'paid' }).eq('id', id);
      return res.json({ success: true, status: 'paid' });
    }

    res.json({ success: false, status: payment.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug-key', (req, res) => {
  const key = process.env.MOYASAR_SECRET_KEY || '';
  res.json({ length: key.length, start: key.slice(0, 12), end: key.slice(-6) });
});

// جلب الطلبات النشطة للوحة التحكم
app.get('/api/dashboard/orders', async (req, res) => {
  try {
    const { data: orders, error } = await supabase
      .from('orders')
      .select(`
        id, status, payment_status, total_price, order_type, created_at,
        table_id, customer_id,
        tables(table_number),
        customers(name, phone),
        order_items(id, quantity, unit_price, products(name))
      `)
      .neq('status', 'completed')
      .neq('status', 'cancelled')
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json({ orders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// تحديث حالة الطلب
app.patch('/api/orders/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const validStatuses = ['pending', 'preparing', 'ready', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'حالة غير صحيحة' });
    }
    const { error } = await supabase.from('orders').update({ status }).eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// جلب حالة طلب معين (للعميل)
app.get('/api/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: order, error } = await supabase
      .from('orders')
      .select('id, status, payment_status, total_price')
      .eq('id', id)
      .single();
    if (error || !order) return res.status(404).json({ error: 'الطلب غير موجود' });
    res.json({ order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
// جلب عدد زيارات العميل المدفوعة (لعرض تقدم برنامج الولاء)
app.get('/api/customers/visits', async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'رقم الجوال مطلوب' });

    const { data: customer } = await supabase
      .from('customers')
      .select('id')
      .eq('phone', phone)
      .maybeSingle();

    if (!customer) return res.json({ visits: 0 });

    const { count } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', customer.id)
      .eq('payment_status', 'paid');

    res.json({ visits: count || 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
// لعبة خربش واكسب - مرة كل 3 أيام لكل عميل
app.post('/api/customers/scratch', async (req, res) => {
  const { phone, name } = req.body;
  if (!phone) return res.status(400).json({ error: 'رقم الجوال مطلوب' });
  try {
    let { data: customer } = await supabase.from('customers').select('*').eq('phone', phone).maybeSingle();
    if (!customer) {
      const { data: newCustomer, error } = await supabase
        .from('customers')
        .insert({ phone, name })
        .select()
        .single();
      if (error) throw error;
      customer = newCustomer;
    }

    const { data: lastAttempt } = await supabase
      .from('scratch_attempts')
      .select('*')
      .eq('customer_id', customer.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
    if (lastAttempt && Date.now() - new Date(lastAttempt.created_at).getTime() < THREE_DAYS) {
      return res.json({
        eligible: false,
        result: { won: lastAttempt.won, code: lastAttempt.code, discount_percent: lastAttempt.discount_percent },
        created_at: lastAttempt.created_at,
      });
    }

    const won = Math.random() < 0.5;
    let code = null;
    if (won) {
      code = generateRewardCode();
      await supabase.from('loyalty_rewards').insert({
        customer_id: customer.id,
        code,
        reward_type: 'discount_percent',
        discount_percent: 10,
      });
    }

    const { data: attempt, error: attemptError } = await supabase
      .from('scratch_attempts')
      .insert({ customer_id: customer.id, won, code, discount_percent: won ? 10 : null })
      .select()
      .single();
    if (attemptError) throw attemptError;

    res.json({
      eligible: true,
      result: { won, code, discount_percent: won ? 10 : null },
      created_at: attempt.created_at,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});