// 결제창에 보이는 주문명(PG 표시용). 토스 결제창형은 renderPaymentWindow와 requestPayment에 같은 orderName을 넘겨야 하므로
// 결제 시작(lib/payment startCheckout)과 결제 페이지(app/student/payment)가 한 값을 공유한다.
export const PAYMENT_ORDER_NAME = "수강료 결제";
